import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import type {
  ConflictMode,
  FileTransferStatus,
  PreviewFile,
  TransferFileProgress,
  TransferJobSnapshot,
  TransferPreview,
  TransferRequest
} from "../types/transfer.js";
import { getDestinationHealth, getFreeSpace } from "./disk.service.js";
import { hashFile } from "./hash.service.js";
import { saveHistoryRecord } from "./storage.service.js";
import { logEvent, saveJsonLogFile } from "../utils/logger.js";
import { safeJoin, samePath, sanitizePathInput } from "../utils/safePaths.js";

const ONE_GB = 1024 * 1024 * 1024;
const VALID_CONFLICT_MODES = new Set<ConflictMode>(["rename", "replace", "skip", "compare"]);

interface ExpandedFile {
  source: string;
  relativePath: string;
  sizeBytes: number;
}

interface MutableTransferJob extends TransferJobSnapshot {
  _timer?: NodeJS.Timeout;
}

class TransferCanceledError extends Error {
  constructor() {
    super("Transferencia cancelada.");
  }
}

const jobs = new Map<string, MutableTransferJob>();

function validateRequest(input: unknown): TransferRequest {
  const body = input as Partial<TransferRequest>;
  if (!Array.isArray(body.sources) || body.sources.length === 0) {
    throw new Error("Informe ao menos um arquivo ou pasta de origem.");
  }

  const conflictMode = body.conflictMode;
  if (!conflictMode || !VALID_CONFLICT_MODES.has(conflictMode)) {
    throw new Error("Modo de conflito invalido.");
  }

  return {
    sources: body.sources.map((source, index) => sanitizePathInput(source, `source[${index}]`)),
    destination: sanitizePathInput(body.destination, "destination"),
    conflictMode,
    simulation: Boolean(body.simulation),
    safetyMarginPercent:
      typeof body.safetyMarginPercent === "number" && Number.isFinite(body.safetyMarginPercent)
        ? Math.max(1, Math.min(50, body.safetyMarginPercent))
        : 5,
    safetyMarginBytes:
      typeof body.safetyMarginBytes === "number" && Number.isFinite(body.safetyMarginBytes)
        ? Math.max(0, body.safetyMarginBytes)
        : ONE_GB
  };
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
}

async function statIfExists(target: string): Promise<fs.Stats | undefined> {
  try {
    return await fsp.stat(target);
  } catch {
    return undefined;
  }
}

async function canReadFile(target: string): Promise<string | undefined> {
  try {
    const handle = await fsp.open(target, "r");
    await handle.close();
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : "Arquivo bloqueado ou indisponivel.";
  }
}

async function walkDirectory(root: string, current: string, out: ExpandedFile[]): Promise<void> {
  const entries = await fsp.readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) {
      await walkDirectory(root, absolute, out);
    } else if (entry.isFile()) {
      const stat = await fsp.stat(absolute);
      out.push({
        source: absolute,
        relativePath: path.join(path.basename(root), path.relative(root, absolute)),
        sizeBytes: stat.size
      });
    }
  }
}

async function expandSources(sources: string[]): Promise<{ files: ExpandedFile[]; unavailable: PreviewFile[] }> {
  const files: ExpandedFile[] = [];
  const unavailable: PreviewFile[] = [];

  for (const source of sources) {
    const stat = await statIfExists(source);
    if (!stat) {
      unavailable.push({
        source,
        sizeBytes: 0,
        action: "unavailable",
        existsAtDestination: false,
        message: "Origem nao encontrada."
      });
      continue;
    }

    if (stat.isDirectory()) {
      await walkDirectory(source, source, files);
      continue;
    }

    if (stat.isFile()) {
      files.push({
        source,
        relativePath: path.basename(source),
        sizeBytes: stat.size
      });
      continue;
    }

    unavailable.push({
      source,
      sizeBytes: 0,
      action: "unavailable",
      existsAtDestination: false,
      message: "Tipo de origem nao suportado."
    });
  }

  return { files, unavailable };
}

async function findAvailableDestination(target: string): Promise<string> {
  if (!(await pathExists(target))) {
    return target;
  }

  const parsed = path.parse(target);
  for (let index = 1; index < 10000; index += 1) {
    const candidate = path.join(parsed.dir, `${parsed.name} (${index})${parsed.ext}`);
    if (!(await pathExists(candidate))) {
      return candidate;
    }
  }

  throw new Error(`Nao foi possivel criar nome unico para ${target}.`);
}

async function buildPreviewFile(file: ExpandedFile, destination: string, conflictMode: ConflictMode): Promise<PreviewFile> {
  const destinationPath = safeJoin(destination, file.relativePath);
  const readableError = await canReadFile(file.source);
  if (readableError) {
    return {
      source: file.source,
      destination: destinationPath,
      relativePath: file.relativePath,
      sizeBytes: file.sizeBytes,
      action: "unavailable",
      existsAtDestination: false,
      message: readableError
    };
  }

  if (samePath(file.source, destinationPath)) {
    return {
      source: file.source,
      destination: destinationPath,
      relativePath: file.relativePath,
      sizeBytes: file.sizeBytes,
      action: "conflict",
      existsAtDestination: true,
      message: "Origem e destino sao o mesmo arquivo."
    };
  }

  const destinationExists = await pathExists(destinationPath);
  if (!destinationExists) {
    return {
      source: file.source,
      destination: destinationPath,
      relativePath: file.relativePath,
      sizeBytes: file.sizeBytes,
      action: "move",
      existsAtDestination: false
    };
  }

  if (conflictMode === "rename") {
    return {
      source: file.source,
      destination: await findAvailableDestination(destinationPath),
      relativePath: file.relativePath,
      sizeBytes: file.sizeBytes,
      action: "rename",
      existsAtDestination: true,
      message: "Destino ja existia; sera usado um nome automatico."
    };
  }

  if (conflictMode === "replace") {
    return {
      source: file.source,
      destination: destinationPath,
      relativePath: file.relativePath,
      sizeBytes: file.sizeBytes,
      action: "replace",
      existsAtDestination: true,
      message: "Substituicao solicitada explicitamente."
    };
  }

  if (conflictMode === "skip") {
    return {
      source: file.source,
      destination: destinationPath,
      relativePath: file.relativePath,
      sizeBytes: file.sizeBytes,
      action: "skip",
      existsAtDestination: true,
      message: "Arquivo ignorado por conflito."
    };
  }

  const [sourceHash, destinationHash] = await Promise.all([hashFile(file.source), hashFile(destinationPath)]);
  return {
    source: file.source,
    destination: destinationPath,
    relativePath: file.relativePath,
    sizeBytes: file.sizeBytes,
    action: sourceHash === destinationHash ? "skip" : "conflict",
    existsAtDestination: true,
    hashMatch: sourceHash === destinationHash,
    message: sourceHash === destinationHash ? "Hashes iguais; arquivo sera ignorado." : "Hashes diferentes; nenhuma sobrescrita sera feita."
  };
}

export async function previewTransfer(input: unknown): Promise<TransferPreview> {
  const request = validateRequest(input);
  const destinationStat = await statIfExists(request.destination);
  const destinationExists = Boolean(destinationStat?.isDirectory());
  const warnings: string[] = [];

  const { files, unavailable } = await expandSources(request.sources);
  const previewFiles = destinationExists
    ? await Promise.all(files.map((file) => buildPreviewFile(file, request.destination, request.conflictMode)))
    : files.map<PreviewFile>((file) => ({
        source: file.source,
        relativePath: file.relativePath,
        sizeBytes: file.sizeBytes,
        action: "unavailable",
        existsAtDestination: false,
        message: "Destino nao existe ou nao e uma pasta."
      }));

  const allFiles = [...previewFiles, ...unavailable];
  const movableFiles = allFiles.filter((file) => ["move", "rename", "replace"].includes(file.action));
  const totalBytes = movableFiles.reduce((sum, file) => sum + file.sizeBytes, 0);
  let destinationFreeBeforeBytes: number | undefined;
  let destinationFreeAfterBytes: number | undefined;
  let safetyMarginBytes: number | undefined;
  let hasEnoughSpace = destinationExists;
  let destinationHealthStatus: string | undefined;

  if (destinationExists) {
    try {
      const freeSpace = await getFreeSpace(request.destination);
      destinationFreeBeforeBytes = freeSpace.freeBytes;
      safetyMarginBytes = Math.max(request.safetyMarginBytes ?? ONE_GB, Math.ceil(freeSpace.totalBytes * ((request.safetyMarginPercent ?? 5) / 100)));
      destinationFreeAfterBytes = freeSpace.freeBytes - totalBytes;
      hasEnoughSpace = destinationFreeAfterBytes >= safetyMarginBytes;
      if (!hasEnoughSpace) {
        warnings.push("Espaco livre insuficiente considerando a margem de seguranca.");
      }
    } catch (error) {
      hasEnoughSpace = false;
      warnings.push(error instanceof Error ? error.message : "Nao foi possivel verificar espaco livre.");
    }

    try {
      destinationHealthStatus = await getDestinationHealth(request.destination);
      if (destinationHealthStatus === "warning" || destinationHealthStatus === "critical") {
        warnings.push("O disco de destino aparenta ter risco de saude.");
      }
    } catch {
      warnings.push("Nao foi possivel verificar a saude do disco de destino.");
    }
  } else {
    warnings.push("Destino nao existe ou nao e uma pasta.");
    hasEnoughSpace = false;
  }

  const conflicts = allFiles.filter((file) => file.action === "conflict" || file.existsAtDestination);
  const unavailableFiles = allFiles.filter((file) => file.action === "unavailable");

  return {
    sources: request.sources,
    destination: request.destination,
    conflictMode: request.conflictMode,
    simulation: request.simulation,
    files: allFiles,
    totalBytes,
    fileCount: movableFiles.length,
    conflicts,
    unavailable: unavailableFiles,
    destinationExists,
    destinationFreeBeforeBytes,
    destinationFreeAfterBytes,
    safetyMarginBytes,
    hasEnoughSpace,
    destinationHealthStatus,
    warnings
  };
}

function snapshot(job: MutableTransferJob): TransferJobSnapshot {
  const { _timer, ...safe } = job;
  void _timer;
  return JSON.parse(JSON.stringify(safe)) as TransferJobSnapshot;
}

function touch(job: MutableTransferJob): void {
  job.updatedAt = new Date().toISOString();
}

function createJob(preview: TransferPreview): MutableTransferJob {
  const files = preview.files
    .filter((file) => file.destination)
    .map<TransferFileProgress>((file) => ({
      id: randomUUID(),
      source: file.source,
      destination: file.destination as string,
      sizeBytes: file.sizeBytes,
      transferredBytes: 0,
      status: file.action === "skip" || file.action === "conflict" || file.action === "unavailable" ? "skipped" : "queued",
      message: file.message
    }));

  const job: MutableTransferJob = {
    jobId: randomUUID(),
    status: preview.simulation ? "simulation" : "queued",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    destination: preview.destination,
    conflictMode: preview.conflictMode,
    simulation: preview.simulation,
    totalBytes: files.filter((file) => file.status === "queued").reduce((sum, file) => sum + file.sizeBytes, 0),
    transferredBytes: 0,
    files,
    errors: [],
    paused: false,
    cancelRequested: false
  };

  jobs.set(job.jobId, job);
  return job;
}

async function writeWithBackpressure(stream: fs.WriteStream, chunk: Buffer): Promise<void> {
  if (!stream.write(chunk)) {
    await once(stream, "drain");
  }
}

async function waitIfPaused(job: MutableTransferJob): Promise<void> {
  while (job.paused && !job.cancelRequested) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (job.cancelRequested) {
    throw new TransferCanceledError();
  }
}

async function copyFileWithProgress(source: string, partialDestination: string, job: MutableTransferJob, file: TransferFileProgress): Promise<void> {
  await fsp.mkdir(path.dirname(partialDestination), { recursive: true });
  await fsp.rm(partialDestination, { force: true });

  const reader = fs.createReadStream(source, { highWaterMark: 1024 * 1024 });
  const writer = fs.createWriteStream(partialDestination, { flags: "wx" });

  try {
    for await (const chunk of reader) {
      await waitIfPaused(job);
      await writeWithBackpressure(writer, chunk as Buffer);
      file.transferredBytes += (chunk as Buffer).length;
      job.transferredBytes += (chunk as Buffer).length;
      touch(job);
    }
    writer.end();
    await once(writer, "finish");
  } catch (error) {
    reader.destroy();
    writer.destroy();
    throw error;
  }
}

async function moveFileSafely(job: MutableTransferJob, file: TransferFileProgress, replace: boolean): Promise<void> {
  const partialDestination = `${file.destination}.partial`;
  let sourceHash: string | undefined;
  let destinationHash: string | undefined;

  try {
    if (samePath(file.source, file.destination)) {
      throw new Error("Origem e destino sao o mesmo arquivo.");
    }

    file.status = "copying";
    job.currentFileId = file.id;
    touch(job);

    await copyFileWithProgress(file.source, partialDestination, job, file);
    await waitIfPaused(job);

    file.status = "verifying";
    touch(job);
    sourceHash = await hashFile(file.source);
    destinationHash = await hashFile(partialDestination);
    file.hashSource = sourceHash;
    file.hashDestination = destinationHash;

    if (sourceHash !== destinationHash) {
      await fsp.rm(partialDestination, { force: true });
      throw new Error("Hashes SHA-256 diferentes. Original preservado.");
    }

    file.status = "finalizing";
    touch(job);

    if (await pathExists(file.destination)) {
      if (!replace) {
        await fsp.rm(partialDestination, { force: true });
        throw new Error("Destino ja existe e substituicao nao foi confirmada.");
      }
      await fsp.rm(file.destination, { force: true });
    }

    await fsp.rename(partialDestination, file.destination);
    await fsp.unlink(file.source);

    file.status = "success";
    file.transferredBytes = file.sizeBytes;
    file.message = "Transferido e validado por SHA-256.";
    touch(job);

    saveHistoryRecord({
      sourcePath: file.source,
      destinationPath: file.destination,
      sizeBytes: file.sizeBytes,
      hashSource: sourceHash,
      hashDestination: destinationHash,
      status: "success"
    });
    await logEvent("transfer.success", { jobId: job.jobId, source: file.source, destination: file.destination });
  } catch (error) {
    await fsp.rm(partialDestination, { force: true }).catch(() => undefined);
    if (error instanceof TransferCanceledError) {
      file.status = "canceled";
      file.message = error.message;
      saveHistoryRecord({
        sourcePath: file.source,
        destinationPath: file.destination,
        sizeBytes: file.sizeBytes,
        hashSource: sourceHash,
        hashDestination: destinationHash,
        status: "canceled",
        errorMessage: error.message
      });
      throw error;
    }

    file.status = "error";
    file.message = error instanceof Error ? error.message : "Erro desconhecido.";
    job.errors.push(file.message);
    saveHistoryRecord({
      sourcePath: file.source,
      destinationPath: file.destination,
      sizeBytes: file.sizeBytes,
      hashSource: sourceHash,
      hashDestination: destinationHash,
      status: "error",
      errorMessage: file.message
    });
    await logEvent("transfer.error", { jobId: job.jobId, source: file.source, error: file.message });
  } finally {
    touch(job);
  }
}

async function runJob(job: MutableTransferJob): Promise<void> {
  job.status = "running";
  touch(job);
  await logEvent("transfer.start", { jobId: job.jobId, destination: job.destination });

  try {
    for (const file of job.files) {
      if (job.cancelRequested) {
        throw new TransferCanceledError();
      }
      if (file.status !== "queued") {
        continue;
      }
      await moveFileSafely(job, file, job.conflictMode === "replace");
    }

    job.status = job.cancelRequested ? "canceled" : "completed";
    job.currentFileId = undefined;
    touch(job);
    await logEvent("transfer.complete", { jobId: job.jobId, status: job.status });
  } catch (error) {
    if (error instanceof TransferCanceledError) {
      job.status = "canceled";
      job.files
        .filter((file) => file.status === "queued" || file.status === "copying" || file.status === "verifying" || file.status === "finalizing")
        .forEach((file) => {
          file.status = "canceled";
          file.message = "Cancelado antes de concluir.";
        });
    } else {
      job.status = "failed";
      job.errors.push(error instanceof Error ? error.message : "Falha inesperada.");
    }
    job.currentFileId = undefined;
    touch(job);
    await logEvent("transfer.finish_with_error", { jobId: job.jobId, status: job.status, errors: job.errors });
  }
}

export async function startTransfer(input: unknown): Promise<TransferJobSnapshot> {
  const preview = await previewTransfer(input);
  if (!preview.destinationExists) {
    throw new Error("Destino inexistente.");
  }
  if (!preview.hasEnoughSpace) {
    throw new Error("Espaco livre insuficiente no destino.");
  }
  if (preview.unavailable.length > 0) {
    throw new Error("Ha arquivos indisponiveis na pre-visualizacao.");
  }
  if (preview.files.some((file) => file.action === "conflict")) {
    throw new Error("Ha conflitos sem resolucao explicita.");
  }

  const job = createJob(preview);
  await saveJsonLogFile(`transfer-plan-${job.jobId}.json`, preview);

  if (preview.simulation) {
    job.files.forEach((file) => {
      if (file.status === "queued") {
        file.status = "simulated";
        file.transferredBytes = file.sizeBytes;
        file.message = "Simulacao concluida. Nenhum arquivo foi movido.";
      }
    });
    job.transferredBytes = job.totalBytes;
    job.status = "simulation";
    touch(job);
    await logEvent("transfer.simulation", { jobId: job.jobId, files: job.files.length });
    return snapshot(job);
  }

  setImmediate(() => {
    void runJob(job);
  });

  return snapshot(job);
}

export function getTransferStatus(jobId: string): TransferJobSnapshot | undefined {
  const job = jobs.get(jobId);
  return job ? snapshot(job) : undefined;
}

export function cancelTransfer(jobId: string): TransferJobSnapshot | undefined {
  const job = jobs.get(jobId);
  if (!job) {
    return undefined;
  }

  job.cancelRequested = true;
  job.paused = false;
  touch(job);
  return snapshot(job);
}

export function pauseTransfer(jobId: string): TransferJobSnapshot | undefined {
  const job = jobs.get(jobId);
  if (!job || job.status !== "running") {
    return job ? snapshot(job) : undefined;
  }

  job.paused = true;
  job.status = "paused";
  touch(job);
  return snapshot(job);
}

export function resumeTransfer(jobId: string): TransferJobSnapshot | undefined {
  const job = jobs.get(jobId);
  if (!job || job.status !== "paused") {
    return job ? snapshot(job) : undefined;
  }

  job.paused = false;
  job.status = "running";
  touch(job);
  return snapshot(job);
}

export async function cleanupPartialFiles(rootInput: unknown, olderThanHoursInput: unknown): Promise<{ deleted: string[]; skipped: string[] }> {
  const root = sanitizePathInput(rootInput, "root");
  const stat = await statIfExists(root);
  if (!stat?.isDirectory()) {
    throw new Error("Raiz de limpeza precisa ser uma pasta existente.");
  }

  const olderThanHours = typeof olderThanHoursInput === "number" && olderThanHoursInput > 0 ? olderThanHoursInput : 24;
  const cutoff = Date.now() - olderThanHours * 60 * 60 * 1000;
  const deleted: string[] = [];
  const skipped: string[] = [];

  async function walk(current: string): Promise<void> {
    const entries = await fsp.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".partial")) {
        continue;
      }
      const fileStat = await fsp.stat(absolute);
      if (fileStat.mtimeMs > cutoff) {
        skipped.push(absolute);
        continue;
      }
      await fsp.rm(absolute, { force: true });
      deleted.push(absolute);
    }
  }

  await walk(root);
  await logEvent("cleanup.partials", { root, deleted: deleted.length, skipped: skipped.length });
  return { deleted, skipped };
}

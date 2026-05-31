import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import type { LinkType, RelocationJobSnapshot, RelocationPreview, RelocationRequest } from "../types/relocation.js";
import type { JobStatus } from "../types/transfer.js";
import { getDestinationHealth, getFreeSpace } from "./disk.service.js";
import { hashFile } from "./hash.service.js";
import { saveHistoryRecord } from "./storage.service.js";
import { logEvent, saveJsonLogFile } from "../utils/logger.js";
import { assertChildPath, safeJoin, samePath, sanitizePathInput } from "../utils/safePaths.js";

const ONE_GB = 1024 * 1024 * 1024;
const VALID_LINK_TYPES = new Set<LinkType>(["junction", "symlink"]);

interface RelocationEntry {
  source: string;
  relativePath: string;
  sizeBytes: number;
  type: "file" | "directory" | "symlink";
  symlinkTarget?: string;
}

interface MutableRelocationJob extends RelocationJobSnapshot {
  temporaryPath: string;
  entries: RelocationEntry[];
}

class RelocationCanceledError extends Error {
  constructor() {
    super("Relocacao cancelada.");
  }
}

const jobs = new Map<string, MutableRelocationJob>();

function timestampSuffix(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function normalizeName(value: unknown, fallback: string): string {
  if (typeof value !== "string" || !value.trim()) {
    return fallback;
  }

  const candidate = value.trim();
  if (candidate.includes("/") || candidate.includes("\\") || candidate.includes(":") || candidate.includes("\0")) {
    throw new Error("Nome de destino invalido.");
  }
  return candidate;
}

function validateRequest(input: unknown): RelocationRequest {
  const body = input as Partial<RelocationRequest>;
  const linkType = body.linkType ?? "junction";
  if (!VALID_LINK_TYPES.has(linkType)) {
    throw new Error("Tipo de link invalido.");
  }

  const source = sanitizePathInput(body.source, "source");
  const destinationParent = sanitizePathInput(body.destinationParent, "destinationParent");
  const destinationName = normalizeName(body.destinationName, path.basename(source));

  return {
    source,
    destinationParent,
    destinationName,
    linkType,
    simulation: Boolean(body.simulation),
    keepBackup: body.keepBackup !== false,
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

async function lstatIfExists(target: string): Promise<fs.Stats | undefined> {
  try {
    return await fsp.lstat(target);
  } catch {
    return undefined;
  }
}

async function walkRelocationDirectory(root: string, current: string, entries: RelocationEntry[]): Promise<void> {
  const children = await fsp.readdir(current, { withFileTypes: true });
  for (const child of children) {
    const absolute = path.join(current, child.name);
    const relativePath = path.relative(root, absolute);
    const childStat = await fsp.lstat(absolute);

    if (childStat.isSymbolicLink()) {
      entries.push({
        source: absolute,
        relativePath,
        sizeBytes: 0,
        type: "symlink",
        symlinkTarget: await fsp.readlink(absolute)
      });
      continue;
    }

    if (childStat.isDirectory()) {
      entries.push({
        source: absolute,
        relativePath,
        sizeBytes: 0,
        type: "directory"
      });
      await walkRelocationDirectory(root, absolute, entries);
      continue;
    }

    if (childStat.isFile()) {
      entries.push({
        source: absolute,
        relativePath,
        sizeBytes: childStat.size,
        type: "file"
      });
    }
  }
}

async function getEntries(source: string): Promise<RelocationEntry[]> {
  const entries: RelocationEntry[] = [];
  await walkRelocationDirectory(source, source, entries);
  return entries;
}

async function writeWithBackpressure(stream: fs.WriteStream, chunk: Buffer): Promise<void> {
  if (!stream.write(chunk)) {
    await once(stream, "drain");
  }
}

async function copyFileWithProgress(job: MutableRelocationJob, entry: RelocationEntry, target: string): Promise<void> {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.rm(target, { force: true });

  const reader = fs.createReadStream(entry.source, { highWaterMark: 1024 * 1024 });
  const writer = fs.createWriteStream(target, { flags: "wx" });

  try {
    for await (const chunk of reader) {
      if (job.cancelRequested) {
        throw new RelocationCanceledError();
      }
      await writeWithBackpressure(writer, chunk as Buffer);
      job.copiedBytes += (chunk as Buffer).length;
      job.updatedAt = new Date().toISOString();
    }
    writer.end();
    await once(writer, "finish");
  } catch (error) {
    reader.destroy();
    writer.destroy();
    throw error;
  }
}

function snapshot(job: MutableRelocationJob): RelocationJobSnapshot {
  const { entries, temporaryPath, ...safe } = job;
  void entries;
  void temporaryPath;
  return JSON.parse(JSON.stringify(safe)) as RelocationJobSnapshot;
}

function setStage(job: MutableRelocationJob, stage: string, status?: JobStatus): void {
  job.stage = stage;
  if (status) {
    job.status = status;
  }
  job.updatedAt = new Date().toISOString();
}

async function createTransparentLink(linkPath: string, targetPath: string, linkType: LinkType): Promise<void> {
  if (linkType === "junction") {
    await fsp.symlink(path.resolve(targetPath), linkPath, "junction");
    return;
  }

  await fsp.symlink(path.resolve(targetPath), linkPath, "dir");
}

async function rollbackOriginalIfNeeded(source: string, backupPath: string): Promise<void> {
  if (!(await pathExists(source)) && (await pathExists(backupPath))) {
    await fsp.rename(backupPath, source);
  }
}

export async function previewRelocation(input: unknown): Promise<RelocationPreview> {
  const request = validateRequest(input);
  const sourceStat = await lstatIfExists(request.source);
  const sourceExists = Boolean(sourceStat);
  const sourceIsDirectory = Boolean(sourceStat?.isDirectory());
  const destinationParentStat = await statIfExists(request.destinationParent);
  const destinationParentExists = Boolean(destinationParentStat?.isDirectory());
  const destinationPath = safeJoin(request.destinationParent, request.destinationName ?? path.basename(request.source));
  const temporaryPath = `${destinationPath}.safedisk-partial`;
  const backupPath = `${request.source}.safedisk-backup-${timestampSuffix()}`;
  const warnings: string[] = [];

  if (!sourceExists) {
    warnings.push("A pasta de origem nao existe.");
  } else if (!sourceIsDirectory) {
    warnings.push("A origem precisa ser uma pasta.");
  } else if (sourceStat?.isSymbolicLink()) {
    warnings.push("A origem ja parece ser um link. Relocar links existentes pode nao ser necessario.");
  }

  if (!destinationParentExists) {
    warnings.push("A pasta de destino nao existe.");
  }

  if (samePath(request.source, destinationPath)) {
    warnings.push("Origem e destino calculado sao iguais.");
  }

  assertChildPath(request.destinationParent, destinationPath);

  const destinationAvailable = destinationParentExists && !(await pathExists(destinationPath));
  const temporaryAvailable = destinationParentExists && !(await pathExists(temporaryPath));
  if (!destinationAvailable) {
    warnings.push("A pasta final de destino ja existe.");
  }
  if (!temporaryAvailable) {
    warnings.push("A pasta temporaria de relocacao ja existe.");
  }

  let entries: RelocationEntry[] = [];
  if (sourceExists && sourceIsDirectory) {
    entries = await getEntries(request.source);
  }

  const totalBytes = entries.reduce((sum, entry) => sum + entry.sizeBytes, 0);
  const fileCount = entries.filter((entry) => entry.type === "file").length;
  const directoryCount = entries.filter((entry) => entry.type === "directory").length;
  const symlinkCount = entries.filter((entry) => entry.type === "symlink").length;
  let destinationFreeBeforeBytes: number | undefined;
  let destinationFreeAfterBytes: number | undefined;
  let safetyMarginBytes: number | undefined;
  let hasEnoughSpace = destinationParentExists;

  if (destinationParentExists) {
    try {
      const freeSpace = await getFreeSpace(request.destinationParent);
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
      const destinationHealth = await getDestinationHealth(request.destinationParent);
      if (destinationHealth === "warning" || destinationHealth === "critical") {
        warnings.push("O disco de destino aparenta ter risco de saude.");
      }
    } catch {
      warnings.push("Nao foi possivel verificar a saude do disco de destino.");
    }
  }

  return {
    source: request.source,
    destinationParent: request.destinationParent,
    destinationPath,
    linkPath: request.source,
    temporaryPath,
    backupPath,
    linkType: request.linkType,
    simulation: request.simulation,
    keepBackup: request.keepBackup,
    sourceExists,
    sourceIsDirectory,
    destinationParentExists,
    destinationAvailable,
    temporaryAvailable,
    fileCount,
    directoryCount,
    symlinkCount,
    totalBytes,
    destinationFreeBeforeBytes,
    destinationFreeAfterBytes,
    safetyMarginBytes,
    hasEnoughSpace,
    warnings
  };
}

function createJob(preview: RelocationPreview, entries: RelocationEntry[]): MutableRelocationJob {
  const job: MutableRelocationJob = {
    jobId: randomUUID(),
    status: preview.simulation ? "simulation" : "queued",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    source: preview.source,
    destinationPath: preview.destinationPath,
    linkPath: preview.linkPath,
    backupPath: preview.backupPath,
    linkType: preview.linkType,
    simulation: preview.simulation,
    keepBackup: preview.keepBackup,
    totalBytes: preview.totalBytes,
    copiedBytes: 0,
    fileCount: preview.fileCount,
    processedFiles: 0,
    stage: preview.simulation ? "Simulacao concluida. Nenhum arquivo foi movido." : "Aguardando inicio.",
    errors: [],
    cancelRequested: false,
    temporaryPath: preview.temporaryPath,
    entries
  };

  jobs.set(job.jobId, job);
  return job;
}

async function runRelocation(job: MutableRelocationJob): Promise<void> {
  setStage(job, "Copiando arquivos para pasta temporaria.", "running");
  await logEvent("relocation.start", { jobId: job.jobId, source: job.source, destination: job.destinationPath });

  try {
    await fsp.rm(job.temporaryPath, { recursive: true, force: true });
    await fsp.mkdir(job.temporaryPath, { recursive: true });

    for (const entry of job.entries) {
      if (job.cancelRequested) {
        throw new RelocationCanceledError();
      }

      const target = safeJoin(job.temporaryPath, entry.relativePath);
      job.currentFile = entry.source;

      if (entry.type === "directory") {
        await fsp.mkdir(target, { recursive: true });
        continue;
      }

      if (entry.type === "symlink") {
        await fsp.mkdir(path.dirname(target), { recursive: true });
        await fsp.symlink(entry.symlinkTarget ?? "", target);
        continue;
      }

      await copyFileWithProgress(job, entry, target);
      setStage(job, "Validando hash SHA-256.");
      const sourceHash = await hashFile(entry.source);
      const destinationHash = await hashFile(target);
      if (sourceHash !== destinationHash) {
        throw new Error(`Hash diferente em ${entry.source}. Original preservado.`);
      }

      job.processedFiles += 1;
      saveHistoryRecord({
        sourcePath: entry.source,
        destinationPath: target,
        sizeBytes: entry.sizeBytes,
        hashSource: sourceHash,
        hashDestination: destinationHash,
        status: "success"
      });
      setStage(job, "Copiando arquivos para pasta temporaria.");
    }

    setStage(job, "Promovendo pasta temporaria para destino final.");
    await fsp.rename(job.temporaryPath, job.destinationPath);

    setStage(job, "Movendo pasta original para backup.");
    await fsp.rename(job.source, job.backupPath);

    try {
      setStage(job, "Criando link transparente no caminho antigo.");
      await createTransparentLink(job.linkPath, job.destinationPath, job.linkType);
      const linkStat = await lstatIfExists(job.linkPath);
      if (!linkStat?.isSymbolicLink()) {
        throw new Error("Link criado nao foi reconhecido como junction/symlink.");
      }
    } catch (error) {
      await rollbackOriginalIfNeeded(job.source, job.backupPath);
      throw error;
    }

    if (!job.keepBackup) {
      setStage(job, "Removendo backup original apos validacao.");
      await fsp.rm(job.backupPath, { recursive: true, force: true });
    }

    setStage(job, job.keepBackup ? "Concluido. Backup original preservado." : "Concluido. Backup removido apos validacao.", "completed");
    job.currentFile = undefined;
    await logEvent("relocation.complete", {
      jobId: job.jobId,
      source: job.source,
      destination: job.destinationPath,
      backup: job.keepBackup ? job.backupPath : undefined
    });
  } catch (error) {
    await fsp.rm(job.temporaryPath, { recursive: true, force: true }).catch(() => undefined);
    if (error instanceof RelocationCanceledError) {
      setStage(job, error.message, "canceled");
    } else {
      const message = error instanceof Error ? error.message : "Falha inesperada na relocacao.";
      job.errors.push(message);
      setStage(job, message, "failed");
      await rollbackOriginalIfNeeded(job.source, job.backupPath).catch(() => undefined);
    }

    job.currentFile = undefined;
    await logEvent("relocation.error", { jobId: job.jobId, status: job.status, errors: job.errors });
  }
}

export async function startRelocation(input: unknown): Promise<RelocationJobSnapshot> {
  const request = validateRequest(input);
  const preview = await previewRelocation(request);
  if (!preview.sourceExists || !preview.sourceIsDirectory) {
    throw new Error("Origem precisa ser uma pasta existente.");
  }
  if (!preview.destinationParentExists) {
    throw new Error("Destino precisa ser uma pasta existente.");
  }
  if (!preview.destinationAvailable || !preview.temporaryAvailable) {
    throw new Error("Destino final ou temporario ja existe.");
  }
  if (!preview.hasEnoughSpace) {
    throw new Error("Espaco livre insuficiente no destino.");
  }

  const entries = await getEntries(request.source);
  const job = createJob(preview, entries);
  await saveJsonLogFile(`relocation-plan-${job.jobId}.json`, preview);

  if (preview.simulation) {
    job.copiedBytes = job.totalBytes;
    job.processedFiles = job.fileCount;
    setStage(job, "Simulacao concluida. Nenhum arquivo foi movido.", "simulation");
    await logEvent("relocation.simulation", { jobId: job.jobId, source: job.source, destination: job.destinationPath });
    return snapshot(job);
  }

  setImmediate(() => {
    void runRelocation(job);
  });

  return snapshot(job);
}

export function getRelocationStatus(jobId: string): RelocationJobSnapshot | undefined {
  const job = jobs.get(jobId);
  return job ? snapshot(job) : undefined;
}

export function cancelRelocation(jobId: string): RelocationJobSnapshot | undefined {
  const job = jobs.get(jobId);
  if (!job) {
    return undefined;
  }

  job.cancelRequested = true;
  job.updatedAt = new Date().toISOString();
  return snapshot(job);
}

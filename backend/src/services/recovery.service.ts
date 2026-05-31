import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import type { DiskHealthStatus, DiskInfo } from "../types/disk.js";
import type {
  RecoveryCategory,
  RecoveryHealthCheck,
  RecoveryHistoryRecord,
  RecoveryJobSnapshot,
  RecoveryLocation,
  RecoveryMode,
  RecoveryPathValidation,
  RecoveryProblem,
  RecoveryResultFile,
  RecoveryStartRequest
} from "../types/recovery.js";
import { getDatabase } from "../db/database.js";
import { getDisks } from "./disk.service.js";
import { logEvent, saveJsonLogFile } from "../utils/logger.js";
import { getDriveLetter, samePath, sanitizePathInput } from "../utils/safePaths.js";

const QUICK_SCAN_MAX_ENTRIES = Number(process.env.SAFEDISK_RECOVERY_QUICK_MAX_ENTRIES ?? 50000);
const QUICK_SCAN_MAX_SAVED = Number(process.env.SAFEDISK_RECOVERY_QUICK_MAX_SAVED ?? 1500);
const DEEP_SCAN_MAX_SAVED = Number(process.env.SAFEDISK_RECOVERY_DEEP_MAX_SAVED ?? 500);
const SAFE_COPY_MAX_ENTRIES = Number(process.env.SAFEDISK_RECOVERY_SAFE_COPY_MAX_ENTRIES ?? 100000);
const BLOCK_SIZE = 4 * 1024 * 1024;
const DEEP_OVERLAP = 1024 * 1024;
const RECENT_FILE_MS = 30 * 24 * 60 * 60 * 1000;
const IMAGE_EXTENSIONS = new Set([".img", ".dd", ".iso", ".bin", ".raw"]);

const CATEGORY_LABELS: Record<RecoveryCategory, string> = {
  images: "Imagens",
  documents: "Documentos",
  videos: "Videos",
  audios: "Audios",
  archives: "Arquivos compactados",
  others: "Outros"
};

const EXTENSION_CATEGORIES: Record<string, RecoveryCategory> = {
  jpg: "images",
  jpeg: "images",
  png: "images",
  gif: "images",
  bmp: "images",
  webp: "images",
  pdf: "documents",
  doc: "documents",
  docx: "documents",
  xls: "documents",
  xlsx: "documents",
  ppt: "documents",
  pptx: "documents",
  txt: "documents",
  rtf: "documents",
  csv: "documents",
  mp4: "videos",
  mov: "videos",
  avi: "videos",
  mkv: "videos",
  mp3: "audios",
  wav: "audios",
  m4a: "audios",
  zip: "archives",
  rar: "archives",
  "7z": "archives"
};

const DEFAULT_QUICK_EXTENSIONS = new Set(Object.keys(EXTENSION_CATEGORIES));
const SKIPPED_DIR_NAMES = new Set([
  "windows",
  "program files",
  "program files (x86)",
  "programdata",
  "system volume information",
  "$windows.~bt",
  "$windows.~ws",
  "node_modules",
  ".git"
]);

interface MutableRecoveryJob extends RecoveryJobSnapshot {
  historySaved?: boolean;
}

interface RecoveryHistoryRow {
  id: string;
  timestamp: string;
  problem: RecoveryProblem;
  origin_path: string;
  destination_path: string;
  mode: RecoveryMode;
  found_count: number;
  saved_count: number;
  status: "concluido" | "cancelado" | "erro";
  notes?: string | null;
}

interface QuickCandidate {
  source: string;
  sizeBytes: number;
  category: RecoveryCategory;
  extension: string;
  reason: string;
}

interface DeepDefinition {
  id: string;
  extension: string;
  category: RecoveryCategory;
  starts: Buffer[];
  end?: Buffer;
  endExtraBytes?: number;
  maxBytes: number;
  minBytes: number;
}

class RecoveryCanceledError extends Error {
  constructor() {
    super("A busca foi interrompida com seguranca.");
  }
}

const jobs = new Map<string, MutableRecoveryJob>();

const DEEP_DEFINITIONS: DeepDefinition[] = [
  {
    id: "jpg",
    extension: "jpg",
    category: "images",
    starts: [Buffer.from([0xff, 0xd8, 0xff])],
    end: Buffer.from([0xff, 0xd9]),
    maxBytes: 50 * 1024 * 1024,
    minBytes: 256
  },
  {
    id: "png",
    extension: "png",
    category: "images",
    starts: [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
    end: Buffer.from([0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]),
    maxBytes: 50 * 1024 * 1024,
    minBytes: 128
  },
  {
    id: "gif",
    extension: "gif",
    category: "images",
    starts: [Buffer.from("GIF87a", "ascii"), Buffer.from("GIF89a", "ascii")],
    end: Buffer.from([0x3b]),
    maxBytes: 30 * 1024 * 1024,
    minBytes: 64
  },
  {
    id: "pdf",
    extension: "pdf",
    category: "documents",
    starts: [Buffer.from("%PDF", "ascii")],
    end: Buffer.from("%%EOF", "ascii"),
    maxBytes: 120 * 1024 * 1024,
    minBytes: 256
  },
  {
    id: "zip",
    extension: "zip",
    category: "archives",
    starts: [Buffer.from([0x50, 0x4b, 0x03, 0x04])],
    end: Buffer.from([0x50, 0x4b, 0x05, 0x06]),
    endExtraBytes: 18,
    maxBytes: 200 * 1024 * 1024,
    minBytes: 128
  },
  {
    id: "mp3",
    extension: "mp3",
    category: "audios",
    starts: [Buffer.from("ID3", "ascii")],
    maxBytes: 35 * 1024 * 1024,
    minBytes: 1024
  }
];

function snapshot(job: MutableRecoveryJob): RecoveryJobSnapshot {
  const { historySaved, ...safe } = job;
  void historySaved;
  return JSON.parse(JSON.stringify(safe)) as RecoveryJobSnapshot;
}

function touch(job: MutableRecoveryJob): void {
  job.updatedAt = new Date().toISOString();
}

function clampProgress(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function addLog(job: MutableRecoveryJob, message: string, details?: unknown): void {
  const suffix = details == null ? "" : ` ${JSON.stringify(details)}`;
  job.advancedLogs.push(`${new Date().toISOString()} ${message}${suffix}`);
  touch(job);
}

function assertNotCanceled(job: MutableRecoveryJob): void {
  if (job.cancelRequested) {
    throw new RecoveryCanceledError();
  }
}

function normalizePathInput(value: unknown, label: string, options: { requireAbsolute?: boolean } = {}): string {
  if (typeof value !== "string") {
    throw new Error(`${label} precisa ser texto.`);
  }

  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${label} nao pode ficar vazio.`);
  }

  if (trimmed.length > 4096 || trimmed.includes("\0")) {
    throw new Error(`${label} contem caracteres invalidos.`);
  }

  if (/(^|[\\/])\.\.([\\/]|$)/.test(trimmed)) {
    throw new Error(`${label} contem navegacao invalida.`);
  }

  const normalized = path.normalize(trimmed.replace(/\//g, path.sep));
  if (options.requireAbsolute !== false && !path.isAbsolute(normalized)) {
    throw new Error(`${label} precisa ser um caminho absoluto.`);
  }

  return normalized;
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

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean).map((value) => path.normalize(value))));
}

function extensionWithoutDot(filePath: string): string {
  return path.extname(filePath).replace(/^\./, "").toLowerCase();
}

function categoryForExtension(extension: string): RecoveryCategory {
  return EXTENSION_CATEGORIES[extension.toLowerCase()] ?? "others";
}

function folderForCategory(destination: string, category: RecoveryCategory): string {
  return path.join(destination, CATEGORY_LABELS[category]);
}

function safeRecoveredName(index: number, extension: string): string {
  return `recuperado_${String(index).padStart(4, "0")}.${extension || "bin"}`;
}

async function ensureUniquePath(target: string): Promise<string> {
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

  throw new Error("Nao foi possivel criar um nome unico para salvar o arquivo.");
}

async function writeWithBackpressure(stream: fs.WriteStream, chunk: Buffer): Promise<void> {
  if (!stream.write(chunk)) {
    await once(stream, "drain");
  }
}

function createJob(request: RecoveryStartRequest): MutableRecoveryJob {
  const job: MutableRecoveryJob = {
    jobId: randomUUID(),
    status: request.demo ? "simulation" : "queued",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    problem: request.problem,
    mode: request.demo ? "demo" : request.mode,
    originPath: request.originPath,
    destinationPath: request.destinationPath,
    phase: request.demo ? "Modo demonstracao" : "Preparando",
    progress: 0,
    foundCount: 0,
    savedCount: 0,
    fileTypes: {},
    results: [],
    warnings: [],
    errors: [],
    advancedLogs: [],
    cancelRequested: false
  };

  jobs.set(job.jobId, job);
  return job;
}

function addRecoveredResult(
  job: MutableRecoveryJob,
  file: Omit<RecoveryResultFile, "id">,
  options: { countType?: boolean } = {}
): RecoveryResultFile {
  const result: RecoveryResultFile = {
    id: randomUUID(),
    ...file
  };
  job.results.push(result);
  job.foundCount += 1;
  if (result.saved) {
    job.savedCount += 1;
  }
  if (options.countType !== false) {
    job.fileTypes[result.type] = (job.fileTypes[result.type] ?? 0) + 1;
  }
  touch(job);
  return result;
}

function toHistoryRecord(row: RecoveryHistoryRow): RecoveryHistoryRecord {
  return {
    id: row.id,
    timestamp: row.timestamp,
    problem: row.problem,
    originPath: row.origin_path,
    destinationPath: row.destination_path,
    mode: row.mode,
    foundCount: row.found_count,
    savedCount: row.saved_count,
    status: row.status,
    notes: row.notes ?? undefined
  };
}

export function saveRecoveryHistory(
  record: Omit<RecoveryHistoryRecord, "id" | "timestamp"> & { id?: string; timestamp?: string; advancedLogs?: string[] }
): RecoveryHistoryRecord {
  const fullRecord: RecoveryHistoryRecord = {
    id: record.id ?? randomUUID(),
    timestamp: record.timestamp ?? new Date().toISOString(),
    problem: record.problem,
    originPath: record.originPath,
    destinationPath: record.destinationPath,
    mode: record.mode,
    foundCount: record.foundCount,
    savedCount: record.savedCount,
    status: record.status,
    notes: record.notes
  };

  getDatabase()
    .prepare(
      `INSERT INTO recovery_history
        (id, timestamp, problem, origin_path, destination_path, mode, found_count, saved_count, status, notes, advanced_logs)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      fullRecord.id,
      fullRecord.timestamp,
      fullRecord.problem,
      fullRecord.originPath,
      fullRecord.destinationPath,
      fullRecord.mode,
      fullRecord.foundCount,
      fullRecord.savedCount,
      fullRecord.status,
      fullRecord.notes ?? null,
      JSON.stringify(record.advancedLogs ?? [])
    );

  return fullRecord;
}

export function getRecoveryHistory(limit = 300): RecoveryHistoryRecord[] {
  const rows = getDatabase()
    .prepare(
      `SELECT id, timestamp, problem, origin_path, destination_path, mode, found_count, saved_count, status, notes
       FROM recovery_history
       ORDER BY timestamp DESC
       LIMIT ?`
    )
    .all(limit) as unknown as RecoveryHistoryRow[];

  return rows.map(toHistoryRecord);
}

function historyStatusForJob(job: RecoveryJobSnapshot): RecoveryHistoryRecord["status"] {
  if (job.status === "completed" || job.status === "simulation") {
    return "concluido";
  }
  if (job.status === "canceled") {
    return "cancelado";
  }
  return "erro";
}

async function finalizeJob(job: MutableRecoveryJob): Promise<void> {
  if (job.historySaved) {
    return;
  }

  job.historySaved = true;
  const notes = [
    job.warnings.join(" "),
    job.errors.join(" ")
  ]
    .filter(Boolean)
    .join(" ");

  saveRecoveryHistory({
    problem: job.problem,
    originPath: job.originPath,
    destinationPath: job.destinationPath,
    mode: job.mode,
    foundCount: job.foundCount,
    savedCount: job.savedCount,
    status: historyStatusForJob(job),
    notes,
    advancedLogs: job.advancedLogs
  });

  await saveJsonLogFile(`recovery-job-${job.jobId}.json`, snapshot(job));
}

function commonUserFolders(): RecoveryLocation[] {
  const home = os.homedir();
  const entries: Array<[string, string, RecoveryLocation["kind"]]> = [
    ["Downloads", path.join(home, "Downloads"), "folder"],
    ["Documentos", path.join(home, "Documents"), "folder"],
    ["Area de Trabalho", path.join(home, "Desktop"), "folder"],
    ["Imagens", path.join(home, "Pictures"), "folder"],
    ["Videos", path.join(home, "Videos"), "folder"],
    ["OneDrive local", path.join(home, "OneDrive"), "backup"],
    ["Google Drive local", path.join(home, "Google Drive"), "backup"],
    ["iCloud Drive local", path.join(home, "iCloudDrive"), "backup"]
  ];

  return entries.map(([label, locationPath, kind]) => ({
    id: `common-${label.toLowerCase().replace(/\s+/g, "-")}`,
    label,
    path: locationPath,
    kind
  }));
}

function driveLabel(disk: DiskInfo, driveLetter: string, volumeLabel?: string): string {
  const prefix = disk.type === "USB" ? "Pendrive ou cartao" : disk.type === "Unknown" ? "Disco" : disk.type;
  const suffix = disk.isSystem || disk.isBoot ? " - Sistema" : volumeLabel ? ` - ${volumeLabel}` : "";
  return `${prefix} ${driveLetter}:${suffix}`;
}

export async function listAvailableLocations(): Promise<RecoveryLocation[]> {
  const disks = await getDisks();
  const driveLocations = disks.flatMap((disk) =>
    disk.volumes
      .filter((volume) => volume.driveLetter)
      .map<RecoveryLocation>((volume) => ({
        id: `drive-${volume.driveLetter}`,
        label: driveLabel(disk, volume.driveLetter as string, volume.label),
        path: `${volume.driveLetter}:\\`,
        kind: disk.type === "USB" ? "removable" : "drive",
        sizeBytes: volume.sizeBytes ?? disk.sizeBytes,
        freeBytes: volume.freeBytes,
        warning: disk.isSystem || disk.isBoot ? "Evite salvar arquivos recuperados neste disco." : undefined
      }))
  );

  const locations = [...driveLocations, ...commonUserFolders()];
  const existing = await Promise.all(
    locations.map(async (location) => ({
      location,
      exists: location.kind === "drive" || location.kind === "removable" || (await pathExists(location.path))
    }))
  );

  return existing.filter((item) => item.exists).map((item) => item.location);
}

function validationErrorResponse(errors: string[], warnings: string[] = [], origin?: string, destination?: string): RecoveryPathValidation {
  return {
    valid: errors.length === 0,
    warnings,
    errors,
    originDrive: origin ? getDriveLetter(origin) : undefined,
    destinationDrive: destination ? getDriveLetter(destination) : undefined
  };
}

export async function validateRecoveryPaths(originInput: unknown, destinationInput: unknown): Promise<RecoveryPathValidation> {
  const warnings: string[] = [];
  const errors: string[] = [];
  let origin = "";
  let destination = "";

  try {
    origin = normalizePathInput(originInput, "origem");
  } catch (error) {
    errors.push(error instanceof Error ? error.message : "Origem invalida.");
  }

  try {
    destination = sanitizePathInput(destinationInput, "destino");
  } catch (error) {
    errors.push(error instanceof Error ? error.message : "Destino invalido.");
  }

  if (errors.length > 0) {
    return validationErrorResponse(errors, warnings, origin, destination);
  }

  const originStat = await statIfExists(origin);
  if (!originStat) {
    errors.push("Nao encontramos o local de origem informado.");
  }

  const destinationDrive = getDriveLetter(destination);
  const originDrive = getDriveLetter(origin);
  if (originDrive && destinationDrive && originDrive === destinationDrive) {
    errors.push("Para proteger seus arquivos, escolha outro disco ou outra unidade para salvar.");
  }

  if (samePath(origin, destination)) {
    errors.push("Origem e destino nao podem ser o mesmo local.");
  }

  if (originStat?.isDirectory()) {
    const relativeDestination = path.relative(origin, destination);
    if (relativeDestination && !relativeDestination.startsWith("..") && !path.isAbsolute(relativeDestination)) {
      errors.push("O destino nao pode ficar dentro do local que esta sendo analisado.");
    }
  }

  if (/^[a-z]:[\\/]?$/i.test(origin)) {
    warnings.push("Voce escolheu um disco inteiro. A busca pode demorar e deve salvar em outro disco.");
  }

  if (originDrive === "C") {
    warnings.push("A origem parece ser o disco do sistema. Pare de usar esse disco enquanto tenta recuperar.");
  }

  if (IMAGE_EXTENSIONS.has(path.extname(origin).toLowerCase())) {
    warnings.push("Arquivo de imagem selecionado. A busca profunda pode demorar.");
  }

  return validationErrorResponse(errors, warnings, origin, destination);
}

function healthLabel(status: DiskHealthStatus): RecoveryHealthCheck["label"] {
  if (status === "healthy") {
    return "Parece saudavel";
  }
  if (status === "warning") {
    return "Atencao: pode ter problemas";
  }
  if (status === "critical") {
    return "Risco alto: recomendamos criar uma copia segura antes";
  }
  return "Nao foi possivel verificar";
}

function healthMessage(status: DiskHealthStatus): string {
  if (status === "healthy") {
    return "Nao encontramos sinais importantes de risco com as informacoes disponiveis.";
  }
  if (status === "warning") {
    return "Ha sinais de atencao. Se os arquivos forem importantes, crie uma copia segura antes.";
  }
  if (status === "critical") {
    return "Evite insistir nesse dispositivo. O caminho mais seguro e criar uma copia antes de procurar arquivos.";
  }
  return "O sistema nao conseguiu ler informacoes suficientes sobre esse disco.";
}

export async function checkStorageHealth(originInput: unknown): Promise<RecoveryHealthCheck> {
  const origin = normalizePathInput(originInput, "origem");
  const drive = getDriveLetter(origin);
  const disks = await getDisks();
  const disk = drive ? disks.find((item) => item.volumes.some((volume) => volume.driveLetter === drive)) : undefined;
  const status = disk?.status ?? "unknown";
  const alerts = [
    disk?.healthMessage,
    disk?.isSystem || disk?.isBoot ? "Disco do sistema selecionado." : undefined,
    disk?.type === "SSD" || disk?.type === "NVMe" ? "Em alguns SSDs, a chance pode ser menor para arquivos apagados." : undefined
  ].filter((item): item is string => Boolean(item));

  return {
    status,
    label: healthLabel(status),
    message: healthMessage(status),
    advanced: {
      model: disk?.model,
      sizeBytes: disk?.sizeBytes,
      type: disk?.type,
      technicalStatus: disk?.statusLabel,
      temperatureC: disk?.temperatureC,
      alerts,
      logs: disk ? [`Disco ${disk.id} associado a ${drive ?? "origem sem unidade"}.`] : ["Nenhum disco associado foi encontrado."]
    }
  };
}

function selectedExtensionSet(extensions: unknown): Set<string> {
  if (!Array.isArray(extensions)) {
    return DEFAULT_QUICK_EXTENSIONS;
  }

  const cleaned = extensions
    .map((item) => String(item).trim().replace(/^\./, "").toLowerCase())
    .filter(Boolean);

  return cleaned.length > 0 ? new Set(cleaned) : DEFAULT_QUICK_EXTENSIONS;
}

function isProbablyHiddenOrTemporary(filePath: string): boolean {
  const base = path.basename(filePath).toLowerCase();
  const normalized = filePath.toLowerCase();
  return (
    base.startsWith(".") ||
    base.startsWith("~") ||
    base.endsWith(".tmp") ||
    base.endsWith(".temp") ||
    normalized.includes(`${path.sep.toLowerCase()}temp${path.sep.toLowerCase()}`) ||
    normalized.includes("$recycle.bin")
  );
}

function shouldKeepQuickCandidate(filePath: string, stat: fs.Stats, selectedExtensions: Set<string>): { keep: boolean; reason: string } {
  const extension = extensionWithoutDot(filePath);
  if (extension && selectedExtensions.has(extension)) {
    return { keep: true, reason: "Tipo escolhido" };
  }

  if (isProbablyHiddenOrTemporary(filePath)) {
    return { keep: true, reason: "Arquivo oculto ou temporario" };
  }

  if (Date.now() - stat.mtimeMs <= RECENT_FILE_MS && DEFAULT_QUICK_EXTENSIONS.has(extension)) {
    return { keep: true, reason: "Arquivo recente" };
  }

  return { keep: false, reason: "" };
}

function shouldSkipDirectory(entryName: string, absolute: string): boolean {
  const lower = entryName.toLowerCase();
  if (SKIPPED_DIR_NAMES.has(lower)) {
    return true;
  }

  const normalized = absolute.toLowerCase();
  return normalized.includes(`${path.sep}appdata${path.sep}local${path.sep}microsoft${path.sep}windows${path.sep}inetcache`);
}

async function quickScanDirectory(
  job: MutableRecoveryJob,
  root: string,
  current: string,
  selectedExtensions: Set<string>,
  candidates: QuickCandidate[],
  counters: { scanned: number }
): Promise<void> {
  assertNotCanceled(job);
  if (counters.scanned >= QUICK_SCAN_MAX_ENTRIES || candidates.length >= QUICK_SCAN_MAX_SAVED) {
    return;
  }

  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(current, { withFileTypes: true });
  } catch (error) {
    job.warnings.push(`Nao foi possivel abrir ${current}.`);
    addLog(job, "quick_scan.readdir_error", { path: current, error: error instanceof Error ? error.message : String(error) });
    return;
  }

  for (const entry of entries) {
    assertNotCanceled(job);
    if (counters.scanned >= QUICK_SCAN_MAX_ENTRIES || candidates.length >= QUICK_SCAN_MAX_SAVED) {
      return;
    }

    const absolute = path.join(current, entry.name);
    counters.scanned += 1;
    job.currentItem = absolute;
    job.progress = clampProgress(Math.min(72, 8 + (counters.scanned / QUICK_SCAN_MAX_ENTRIES) * 64));
    touch(job);

    if (entry.isDirectory()) {
      if (!shouldSkipDirectory(entry.name, absolute)) {
        await quickScanDirectory(job, root, absolute, selectedExtensions, candidates, counters);
      }
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    try {
      const stat = await fsp.stat(absolute);
      const decision = shouldKeepQuickCandidate(absolute, stat, selectedExtensions);
      if (decision.keep) {
        const extension = extensionWithoutDot(absolute);
        candidates.push({
          source: absolute,
          sizeBytes: stat.size,
          category: categoryForExtension(extension),
          extension: extension || "bin",
          reason: decision.reason
        });
      }
    } catch (error) {
      addLog(job, "quick_scan.stat_error", { path: absolute, error: error instanceof Error ? error.message : String(error) });
    }
  }

  void root;
}

function rootsForQuickScan(origin: string, includeCommonFolders: boolean): string[] {
  const roots = [origin];
  const drive = getDriveLetter(origin);
  if (drive) {
    roots.push(`${drive}:\\$Recycle.Bin`);
  }
  if (includeCommonFolders) {
    roots.push(...commonUserFolders().map((location) => location.path));
  }
  return uniqueStrings(roots);
}

async function copyCandidate(job: MutableRecoveryJob, candidate: QuickCandidate, destination: string): Promise<void> {
  assertNotCanceled(job);
  const folder = folderForCategory(destination, candidate.category);
  await fsp.mkdir(folder, { recursive: true });
  const targetName = `${path.parse(candidate.source).name || "arquivo"}.${candidate.extension}`;
  const target = await ensureUniquePath(path.join(folder, targetName));

  await fsp.copyFile(candidate.source, target, fs.constants.COPYFILE_EXCL);
  addRecoveredResult(job, {
    name: path.basename(target),
    path: target,
    type: candidate.extension,
    category: candidate.category,
    sizeBytes: candidate.sizeBytes,
    saved: true,
    sourceHint: candidate.source,
    message: candidate.reason
  });
}

async function runQuickRecovery(job: MutableRecoveryJob, request: RecoveryStartRequest): Promise<void> {
  const validation = await validateRecoveryPaths(request.originPath, request.destinationPath);
  job.warnings.push(...validation.warnings);
  if (!validation.valid) {
    throw new Error(validation.errors.join(" "));
  }

  await fsp.mkdir(request.destinationPath, { recursive: true });
  const selectedExtensions = selectedExtensionSet(request.extensions);
  const roots = rootsForQuickScan(request.originPath, Boolean(request.includeCommonFolders));
  const candidates: QuickCandidate[] = [];
  const counters = { scanned: 0 };

  job.phase = "Verificando pastas";
  job.progress = 5;
  addLog(job, "quick_scan.start", { roots, extensions: Array.from(selectedExtensions) });

  for (const root of roots) {
    const stat = await statIfExists(root);
    if (!stat?.isDirectory()) {
      addLog(job, "quick_scan.skip_missing_root", { root });
      continue;
    }
    await quickScanDirectory(job, root, root, selectedExtensions, candidates, counters);
  }

  job.phase = "Salvando arquivos encontrados";
  job.progress = 74;
  touch(job);

  for (let index = 0; index < candidates.length; index += 1) {
    assertNotCanceled(job);
    const candidate = candidates[index];
    try {
      job.currentItem = candidate.source;
      await copyCandidate(job, candidate, request.destinationPath);
    } catch (error) {
      job.warnings.push(`Alguns arquivos nao puderam ser copiados.`);
      addLog(job, "quick_scan.copy_error", {
        source: candidate.source,
        error: error instanceof Error ? error.message : String(error)
      });
    }
    job.progress = clampProgress(74 + ((index + 1) / Math.max(1, candidates.length)) * 20);
    touch(job);
  }

  if (counters.scanned >= QUICK_SCAN_MAX_ENTRIES) {
    job.warnings.push("A busca rapida chegou ao limite de verificacao desta execucao.");
  }

  job.phase = "Finalizando relatorio";
  job.progress = 98;
}

function findBufferPositions(buffer: Buffer, pattern: Buffer): number[] {
  const positions: number[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const found = buffer.indexOf(pattern, offset);
    if (found === -1) {
      break;
    }
    positions.push(found);
    offset = found + Math.max(1, pattern.length);
  }
  return positions;
}

function findMp4Positions(buffer: Buffer): number[] {
  const positions: number[] = [];
  let offset = 0;
  const marker = Buffer.from("ftyp", "ascii");
  while (offset < buffer.length) {
    const found = buffer.indexOf(marker, offset);
    if (found === -1) {
      break;
    }
    const start = found - 4;
    if (start >= 0 && start + 12 <= buffer.length) {
      const boxSize = buffer.readUInt32BE(start);
      if (boxSize >= 16 && boxSize < 1024 * 1024) {
        positions.push(start);
      }
    }
    offset = found + marker.length;
  }
  return positions;
}

async function maybeReclassifyZip(savedPath: string): Promise<{ path: string; extension: string; category: RecoveryCategory }> {
  const handle = await fsp.open(savedPath, "r");
  try {
    const stat = await handle.stat();
    const buffer = Buffer.alloc(Math.min(stat.size, 2 * 1024 * 1024));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const sample = buffer.subarray(0, bytesRead).toString("latin1");
    const parsed = path.parse(savedPath);
    let extension = "zip";
    if (sample.includes("word/")) {
      extension = "docx";
    } else if (sample.includes("xl/")) {
      extension = "xlsx";
    } else if (sample.includes("ppt/")) {
      extension = "pptx";
    }

    if (extension === "zip") {
      return { path: savedPath, extension, category: "archives" };
    }

    const documentFolder = path.join(path.dirname(path.dirname(savedPath)), CATEGORY_LABELS.documents);
    await fsp.mkdir(documentFolder, { recursive: true });
    const renamed = await ensureUniquePath(path.join(documentFolder, `${parsed.name}.${extension}`));
    await fsp.rename(savedPath, renamed);
    return { path: renamed, extension, category: "documents" };
  } finally {
    await handle.close();
  }
}

async function extractByDefinition(
  job: MutableRecoveryJob,
  source: string,
  startOffset: number,
  definition: DeepDefinition,
  destination: string,
  sequence: number
): Promise<void> {
  assertNotCanceled(job);
  const folder = folderForCategory(destination, definition.category);
  await fsp.mkdir(folder, { recursive: true });
  let target = await ensureUniquePath(path.join(folder, safeRecoveredName(sequence, definition.extension)));
  const reader = await fsp.open(source, "r");
  const writer = fs.createWriteStream(target, { flags: "wx" });
  const readBuffer = Buffer.alloc(BLOCK_SIZE);
  let position = startOffset;
  let written = 0;
  let tail = Buffer.alloc(0);

  try {
    while (written < definition.maxBytes) {
      assertNotCanceled(job);
      const wanted = Math.min(readBuffer.length, definition.maxBytes - written);
      const { bytesRead } = await reader.read(readBuffer, 0, wanted, position);
      if (bytesRead === 0) {
        break;
      }

      const chunk = Buffer.from(readBuffer.subarray(0, bytesRead));
      let writeLength = chunk.length;

      if (definition.end) {
        const combined = Buffer.concat([tail, chunk]);
        const found = combined.indexOf(definition.end);
        if (found !== -1) {
          const combinedStartRelative = position - startOffset - tail.length;
          const targetWritten = combinedStartRelative + found + definition.end.length + (definition.endExtraBytes ?? 0);
          writeLength = Math.max(0, Math.min(chunk.length, targetWritten - written));
        }
      }

      if (writeLength > 0) {
        await writeWithBackpressure(writer, chunk.subarray(0, writeLength));
        written += writeLength;
      }

      position += bytesRead;

      if (writeLength < chunk.length) {
        break;
      }

      if (definition.end) {
        tail = Buffer.concat([tail, chunk]).subarray(-Math.max(64, definition.end.length + (definition.endExtraBytes ?? 0) + 16));
      }
    }

    writer.end();
    await once(writer, "finish");
  } catch (error) {
    writer.destroy();
    throw error;
  } finally {
    await reader.close();
  }

  if (written < definition.minBytes) {
    job.warnings.push("Alguns trechos encontrados eram pequenos demais para serem uteis.");
    addLog(job, "deep_scan.too_small", { startOffset, extension: definition.extension, written });
    return;
  }

  let finalPath = target;
  let finalExtension = definition.extension;
  let finalCategory = definition.category;
  if (definition.id === "zip") {
    const classified = await maybeReclassifyZip(target);
    finalPath = classified.path;
    finalExtension = classified.extension;
    finalCategory = classified.category;
    target = finalPath;
  }

  const stat = await fsp.stat(finalPath);
  addRecoveredResult(job, {
    name: path.basename(finalPath),
    path: finalPath,
    type: finalExtension,
    category: finalCategory,
    sizeBytes: stat.size,
    saved: true,
    sourceHint: `Imagem analisada em ${startOffset}`,
    message: "Nome novo porque o nome original nao estava disponivel."
  });
}

function printableRunSlices(buffer: Buffer): Array<{ start: number; end: number }> {
  const slices: Array<{ start: number; end: number }> = [];
  let start = -1;

  for (let index = 0; index < buffer.length; index += 1) {
    const byte = buffer[index];
    const printable = byte === 0x09 || byte === 0x0a || byte === 0x0d || (byte >= 0x20 && byte <= 0x7e);
    if (printable && start === -1) {
      start = index;
    }
    if ((!printable || index === buffer.length - 1) && start !== -1) {
      const end = printable && index === buffer.length - 1 ? index + 1 : index;
      if (end - start >= 2048) {
        slices.push({ start, end });
      }
      start = -1;
    }
  }

  return slices.slice(0, 3);
}

async function saveTextSlice(job: MutableRecoveryJob, destination: string, slice: Buffer, sequence: number, offset: number): Promise<void> {
  const folder = folderForCategory(destination, "documents");
  await fsp.mkdir(folder, { recursive: true });
  const target = await ensureUniquePath(path.join(folder, safeRecoveredName(sequence, "txt")));
  await fsp.writeFile(target, slice);
  addRecoveredResult(job, {
    name: path.basename(target),
    path: target,
    type: "txt",
    category: "documents",
    sizeBytes: slice.length,
    saved: true,
    sourceHint: `Texto encontrado em ${offset}`,
    message: "Trecho de texto encontrado durante a busca profunda."
  });
}

async function runDeepRecovery(job: MutableRecoveryJob, request: RecoveryStartRequest): Promise<void> {
  const validation = await validateRecoveryPaths(request.originPath, request.destinationPath);
  job.warnings.push(...validation.warnings);
  if (!validation.valid) {
    throw new Error(validation.errors.join(" "));
  }

  const sourceStat = await statIfExists(request.originPath);
  if (!sourceStat?.isFile()) {
    throw new Error("A busca profunda precisa de um arquivo de imagem ou arquivo grande escolhido por voce.");
  }

  await fsp.mkdir(request.destinationPath, { recursive: true });
  job.totalBytes = sourceStat.size;
  job.phase = "Buscando imagens e documentos";
  job.progress = 3;
  addLog(job, "deep_scan.start", { source: request.originPath, sizeBytes: sourceStat.size });

  const reader = fs.createReadStream(request.originPath, { highWaterMark: BLOCK_SIZE });
  let carry = Buffer.alloc(0);
  let processed = 0;
  let sequence = 1;
  const seen = new Set<number>();

  try {
    for await (const rawChunk of reader) {
      assertNotCanceled(job);
      const chunk = rawChunk as Buffer;
      const searchBuffer = Buffer.concat([carry, chunk]);
      const searchStart = processed - carry.length;

      for (const definition of DEEP_DEFINITIONS) {
        for (const start of definition.starts) {
          for (const localPosition of findBufferPositions(searchBuffer, start)) {
            const absolutePosition = searchStart + localPosition;
            if (absolutePosition < 0 || seen.has(absolutePosition) || job.savedCount >= DEEP_SCAN_MAX_SAVED) {
              continue;
            }
            seen.add(absolutePosition);
            job.phase = definition.category === "images" ? "Buscando imagens" : "Buscando documentos";
            await extractByDefinition(job, request.originPath, absolutePosition, definition, request.destinationPath, sequence);
            sequence += 1;
          }
        }
      }

      for (const localPosition of findMp4Positions(searchBuffer)) {
        const absolutePosition = searchStart + localPosition;
        if (absolutePosition < 0 || seen.has(absolutePosition) || job.savedCount >= DEEP_SCAN_MAX_SAVED) {
          continue;
        }
        seen.add(absolutePosition);
        await extractByDefinition(
          job,
          request.originPath,
          absolutePosition,
          {
            id: "mp4",
            extension: "mp4",
            category: "videos",
            starts: [],
            maxBytes: 220 * 1024 * 1024,
            minBytes: 1024
          },
          request.destinationPath,
          sequence
        );
        sequence += 1;
      }

      if (job.savedCount < DEEP_SCAN_MAX_SAVED) {
        for (const slice of printableRunSlices(chunk)) {
          if (job.savedCount >= DEEP_SCAN_MAX_SAVED) {
            break;
          }
          await saveTextSlice(job, request.destinationPath, chunk.subarray(slice.start, slice.end), sequence, processed + slice.start);
          sequence += 1;
        }
      }

      processed += chunk.length;
      job.processedBytes = processed;
      job.currentItem = `${Math.round(processed / 1024 / 1024)} MB analisados`;
      job.progress = clampProgress(Math.min(96, (processed / Math.max(1, sourceStat.size)) * 96));
      carry = searchBuffer.subarray(-DEEP_OVERLAP);
      touch(job);

      if (job.savedCount >= DEEP_SCAN_MAX_SAVED) {
        job.warnings.push("A busca profunda chegou ao limite de arquivos desta execucao.");
        break;
      }
    }
  } finally {
    reader.destroy();
  }

  job.phase = "Finalizando relatorio";
  job.progress = 98;
  if (job.savedCount > 0) {
    job.warnings.push("Alguns arquivos recuperados podem vir com nomes novos porque o nome original nao estava mais disponivel.");
  }
}

async function copyFileWithProgress(
  job: MutableRecoveryJob,
  source: string,
  destination: string,
  sizeBytes: number,
  relativeHint?: string
): Promise<void> {
  assertNotCanceled(job);
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  const reader = fs.createReadStream(source, { highWaterMark: 1024 * 1024 });
  const writer = fs.createWriteStream(destination, { flags: "wx" });
  let copied = 0;

  try {
    for await (const rawChunk of reader) {
      assertNotCanceled(job);
      const chunk = rawChunk as Buffer;
      await writeWithBackpressure(writer, chunk);
      copied += chunk.length;
      job.processedBytes = (job.processedBytes ?? 0) + chunk.length;
      if (job.totalBytes) {
        job.progress = clampProgress(Math.min(96, ((job.processedBytes ?? 0) / job.totalBytes) * 96));
      }
      job.currentItem = source;
      touch(job);
    }
    writer.end();
    await once(writer, "finish");
  } catch (error) {
    reader.destroy();
    writer.destroy();
    throw error;
  }

  addRecoveredResult(job, {
    name: path.basename(destination),
    path: destination,
    type: extensionWithoutDot(destination) || "arquivo",
    category: categoryForExtension(extensionWithoutDot(destination)),
    sizeBytes,
    saved: true,
    sourceHint: relativeHint ?? source,
    message: "Copiado para mexer menos no original."
  });
}

async function collectFilesForSafeCopy(
  job: MutableRecoveryJob,
  root: string,
  current: string,
  out: Array<{ source: string; relativePath: string; sizeBytes: number }>,
  counters: { scanned: number; totalBytes: number }
): Promise<void> {
  assertNotCanceled(job);
  if (counters.scanned >= SAFE_COPY_MAX_ENTRIES) {
    return;
  }

  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(current, { withFileTypes: true });
  } catch (error) {
    job.warnings.push("Pulando partes com erro.");
    addLog(job, "safe_copy.readdir_error", { path: current, error: error instanceof Error ? error.message : String(error) });
    return;
  }

  for (const entry of entries) {
    assertNotCanceled(job);
    if (counters.scanned >= SAFE_COPY_MAX_ENTRIES) {
      return;
    }

    const absolute = path.join(current, entry.name);
    counters.scanned += 1;
    if (entry.isDirectory()) {
      if (!shouldSkipDirectory(entry.name, absolute)) {
        await collectFilesForSafeCopy(job, root, absolute, out, counters);
      }
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    try {
      const stat = await fsp.stat(absolute);
      counters.totalBytes += stat.size;
      out.push({
        source: absolute,
        relativePath: path.relative(root, absolute),
        sizeBytes: stat.size
      });
    } catch (error) {
      addLog(job, "safe_copy.stat_error", { path: absolute, error: error instanceof Error ? error.message : String(error) });
    }
  }
}

async function runSafeCopy(job: MutableRecoveryJob, request: RecoveryStartRequest): Promise<void> {
  const validation = await validateRecoveryPaths(request.originPath, request.destinationPath);
  job.warnings.push(...validation.warnings);
  if (!validation.valid) {
    throw new Error(validation.errors.join(" "));
  }

  const originStat = await statIfExists(request.originPath);
  if (!originStat) {
    throw new Error("Nao encontramos o local de origem informado.");
  }

  const safeCopyRoot = await ensureUniquePath(path.join(request.destinationPath, `copia_segura_${new Date().toISOString().replace(/[:.]/g, "-")}`));
  await fsp.mkdir(safeCopyRoot, { recursive: true });
  job.phase = "Preparando copia";
  job.progress = 4;
  addLog(job, "safe_copy.start", { origin: request.originPath, safeCopyRoot });

  if (originStat.isFile()) {
    job.totalBytes = originStat.size;
    const target = await ensureUniquePath(path.join(safeCopyRoot, path.basename(request.originPath)));
    job.phase = "Copiando arquivos acessiveis";
    await copyFileWithProgress(job, request.originPath, target, originStat.size);
    return;
  }

  if (!originStat.isDirectory()) {
    throw new Error("Esse tipo de origem nao pode ser copiado por este modo.");
  }

  const files: Array<{ source: string; relativePath: string; sizeBytes: number }> = [];
  const counters = { scanned: 0, totalBytes: 0 };
  await collectFilesForSafeCopy(job, request.originPath, request.originPath, files, counters);
  job.totalBytes = counters.totalBytes;
  job.processedBytes = 0;
  job.phase = "Copiando arquivos acessiveis";
  job.progress = 8;

  for (const file of files) {
    assertNotCanceled(job);
    const target = await ensureUniquePath(path.join(safeCopyRoot, file.relativePath));
    try {
      await copyFileWithProgress(job, file.source, target, file.sizeBytes, file.relativePath);
    } catch (error) {
      job.warnings.push("Alguns arquivos nao puderam ser copiados.");
      addLog(job, "safe_copy.copy_error", { source: file.source, error: error instanceof Error ? error.message : String(error) });
    }
  }

  if (counters.scanned >= SAFE_COPY_MAX_ENTRIES) {
    job.warnings.push("A copia chegou ao limite de arquivos desta execucao.");
  }
  job.phase = "Copia concluida";
  job.progress = 98;
}

async function runHealthJob(job: MutableRecoveryJob): Promise<void> {
  job.phase = "Verificando saude do disco";
  job.progress = 40;
  const health = await checkStorageHealth(job.originPath);
  job.progress = 80;
  addLog(job, "health_check.result", health.advanced);
  addRecoveredResult(
    job,
    {
      name: health.label,
      path: job.originPath,
      type: "saude",
      category: "others",
      sizeBytes: 0,
      saved: false,
      message: health.message
    },
    { countType: false }
  );
  job.warnings.push(...health.advanced.alerts);
  job.phase = health.label;
  job.progress = 98;
}

async function runDemoJob(job: MutableRecoveryJob): Promise<void> {
  const demoFiles = [
    { name: "recuperado_0001.jpg", type: "jpg", category: "images" as RecoveryCategory, sizeBytes: 1245000 },
    { name: "recuperado_0002.pdf", type: "pdf", category: "documents" as RecoveryCategory, sizeBytes: 380000 },
    { name: "recuperado_0003.docx", type: "docx", category: "documents" as RecoveryCategory, sizeBytes: 92000 },
    { name: "recuperado_0004.mp4", type: "mp4", category: "videos" as RecoveryCategory, sizeBytes: 8240000 }
  ];

  for (let index = 0; index < demoFiles.length; index += 1) {
    assertNotCanceled(job);
    job.phase = index < 2 ? "Procurando arquivos apagados" : "Salvando arquivos encontrados";
    job.progress = clampProgress((index / demoFiles.length) * 90);
    await new Promise((resolve) => setTimeout(resolve, 450));
    const file = demoFiles[index];
    addRecoveredResult(job, {
      ...file,
      path: path.join(job.destinationPath || "Modo demonstracao", CATEGORY_LABELS[file.category], file.name),
      saved: true,
      sourceHint: "Modo demonstracao",
      message: "Resultado simulado para testar a interface."
    });
  }
  job.warnings.push("Modo demonstracao: nenhum arquivo real foi lido ou salvo.");
  job.phase = "Finalizando relatorio";
  job.progress = 98;
}

function simpleProblemLabel(problem: RecoveryProblem): string {
  const labels: Record<RecoveryProblem, string> = {
    "deleted-files": "Apaguei arquivos sem querer",
    "emptied-trash": "Esvaziei a lixeira",
    "formatted-device": "Formatei um pendrive, cartao ou HD",
    "asks-format": "O dispositivo pede para formatar",
    "device-not-open": "O disco ou pendrive nao abre",
    "missing-files": "Os arquivos sumiram",
    "slow-device": "O disco esta lento ou travando",
    "disk-image": "Quero analisar uma copia de disco"
  };
  return labels[problem];
}

function simpleModeLabel(mode: RecoveryMode): string {
  const labels: Record<RecoveryMode, string> = {
    quick: "Busca rapida",
    deep: "Busca profunda",
    health: "Verificar saude primeiro",
    "safe-copy": "Criar copia segura",
    image: "Analisar arquivo de imagem",
    demo: "Modo demonstracao"
  };
  return labels[mode];
}

function buildSimpleReport(job: RecoveryJobSnapshot): string {
  return [
    "Relatorio de recuperacao de arquivos",
    "",
    `Data da busca: ${new Date(job.createdAt).toLocaleString("pt-BR")}`,
    `Local analisado: ${job.originPath}`,
    `Local onde os arquivos foram salvos: ${job.destinationPath}`,
    `Modo usado: ${simpleModeLabel(job.mode)}`,
    `O que aconteceu: ${simpleProblemLabel(job.problem)}`,
    `Arquivos encontrados: ${job.foundCount}`,
    `Arquivos salvos: ${job.savedCount}`,
    "",
    "Avisos importantes:",
    ...(job.warnings.length > 0 ? job.warnings.map((warning) => `- ${warning}`) : ["- Nenhum aviso registrado."]),
    "",
    "Limitacoes:",
    "- Nem todos os arquivos podem ser recuperados. A chance depende do tipo de dispositivo, do tempo passado e se novos dados foram gravados por cima.",
    "- Arquivos recuperados por busca profunda podem receber nomes novos.",
    "- O SafeDisk nao formata, nao corrige disco automaticamente e nao envia arquivos para internet."
  ].join("\n");
}

function buildAdvancedReport(job: RecoveryJobSnapshot): string {
  return JSON.stringify(job, null, 2);
}

async function writeReports(job: MutableRecoveryJob): Promise<void> {
  if (!job.destinationPath || job.mode === "demo") {
    return;
  }

  try {
    await fsp.mkdir(job.destinationPath, { recursive: true });
    const txtPath = await ensureUniquePath(path.join(job.destinationPath, `relatorio_recuperacao_${job.jobId}.txt`));
    const jsonPath = await ensureUniquePath(path.join(job.destinationPath, `relatorio_recuperacao_${job.jobId}.json`));
    await fsp.writeFile(txtPath, buildSimpleReport(snapshot(job)), "utf8");
    await fsp.writeFile(jsonPath, buildAdvancedReport(snapshot(job)), "utf8");
    job.reportTxtPath = txtPath;
    job.reportJsonPath = jsonPath;
  } catch (error) {
    job.warnings.push("Nao foi possivel salvar o relatorio na pasta escolhida.");
    addLog(job, "report.write_error", { error: error instanceof Error ? error.message : String(error) });
  }
}

async function runRecoveryJob(job: MutableRecoveryJob, request: RecoveryStartRequest): Promise<void> {
  job.status = request.demo ? "simulation" : "running";
  touch(job);
  await logEvent("recovery.start", { jobId: job.jobId, mode: job.mode, origin: job.originPath });

  try {
    if (request.demo) {
      await runDemoJob(job);
    } else if (request.mode === "quick") {
      await runQuickRecovery(job, request);
    } else if (request.mode === "deep" || request.mode === "image") {
      await runDeepRecovery(job, request);
    } else if (request.mode === "safe-copy") {
      await runSafeCopy(job, request);
    } else if (request.mode === "health") {
      await runHealthJob(job);
    } else {
      throw new Error("Modo de recuperacao invalido.");
    }

    job.status = request.demo ? "simulation" : "completed";
    job.phase = request.demo ? "Demonstracao concluida" : "Finalizado";
    job.progress = 100;
    job.currentItem = undefined;
    touch(job);
    await writeReports(job);
    await logEvent("recovery.complete", { jobId: job.jobId, status: job.status, found: job.foundCount, saved: job.savedCount });
  } catch (error) {
    if (error instanceof RecoveryCanceledError) {
      job.status = "canceled";
      job.phase = "A busca foi interrompida com seguranca";
      job.warnings.push("A busca foi interrompida com seguranca. Os arquivos ja salvos continuam na pasta escolhida.");
    } else {
      job.status = "failed";
      job.phase = "Nao foi possivel concluir";
      job.errors.push(error instanceof Error ? error.message : "Falha inesperada.");
    }
    job.currentItem = undefined;
    touch(job);
    await logEvent("recovery.finish_with_error", { jobId: job.jobId, status: job.status, errors: job.errors });
  } finally {
    await finalizeJob(job);
  }
}

function validateStartRequest(input: unknown): RecoveryStartRequest {
  const body = input as Partial<RecoveryStartRequest>;
  const validProblems = new Set<RecoveryProblem>([
    "deleted-files",
    "emptied-trash",
    "formatted-device",
    "asks-format",
    "device-not-open",
    "missing-files",
    "slow-device",
    "disk-image"
  ]);
  const validModes = new Set<RecoveryMode>(["quick", "deep", "health", "safe-copy", "image", "demo"]);

  if (!body.problem || !validProblems.has(body.problem)) {
    throw new Error("Escolha o que aconteceu antes de iniciar.");
  }
  if (!body.mode || !validModes.has(body.mode)) {
    throw new Error("Escolha o tipo de busca antes de iniciar.");
  }

  return {
    problem: body.problem,
    originPath: normalizePathInput(body.originPath, "origem"),
    destinationPath: body.demo ? normalizePathInput(body.destinationPath || "C:\\SafeDiskDemo", "destino") : sanitizePathInput(body.destinationPath, "destino"),
    mode: body.mode,
    extensions: Array.isArray(body.extensions) ? body.extensions.map((item) => String(item)) : undefined,
    includeCommonFolders: Boolean(body.includeCommonFolders),
    demo: Boolean(body.demo || body.mode === "demo")
  };
}

export async function startRecoveryJob(input: unknown): Promise<RecoveryJobSnapshot> {
  const request = validateStartRequest(input);
  const job = createJob(request);
  addLog(job, "recovery.request", {
    problem: request.problem,
    mode: request.mode,
    originPath: request.originPath,
    destinationPath: request.destinationPath,
    demo: request.demo
  });

  setImmediate(() => {
    void runRecoveryJob(job, request);
  });

  return snapshot(job);
}

export function getRecoveryProgress(jobId: string): RecoveryJobSnapshot | undefined {
  const job = jobs.get(jobId);
  return job ? snapshot(job) : undefined;
}

export function cancelRecoveryJob(jobId: string): RecoveryJobSnapshot | undefined {
  const job = jobs.get(jobId);
  if (!job) {
    return undefined;
  }
  job.cancelRequested = true;
  touch(job);
  return snapshot(job);
}

export function generateRecoveryReport(jobId: string, format: "txt" | "json"): string | undefined {
  const job = jobs.get(jobId);
  if (!job) {
    return undefined;
  }
  return format === "json" ? buildAdvancedReport(snapshot(job)) : buildSimpleReport(snapshot(job));
}

export async function openRecoveredFolder(folderInput: unknown): Promise<{ ok: true }> {
  const folder = normalizePathInput(folderInput, "pasta");
  const stat = await statIfExists(folder);
  const target = stat?.isDirectory() ? folder : path.dirname(folder);
  if (!(await pathExists(target))) {
    throw new Error("Pasta nao encontrada.");
  }

  await new Promise<void>((resolve, reject) => {
    execFile("explorer.exe", [target], { windowsHide: true }, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });

  return { ok: true };
}

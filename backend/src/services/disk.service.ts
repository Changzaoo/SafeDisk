import type {
  DiskHealthStatus,
  DiskHealthSummary,
  DiskInfo,
  DiskKind,
  FreeSpaceInfo,
  SmartReport,
  VolumeInfo
} from "../types/disk.js";
import { runPowerShell, runWmicDiskDrive } from "../utils/commandRunner.js";
import { getDriveLetter } from "../utils/safePaths.js";
import { detectSmartctl, listSmartDevices, readSmartReport } from "./smart.service.js";

interface PsDisk {
  Number?: number;
  FriendlyName?: string;
  SerialNumber?: string;
  BusType?: string;
  PartitionStyle?: string;
  HealthStatus?: string;
  OperationalStatus?: string | string[];
  Size?: number;
  IsBoot?: boolean;
  IsSystem?: boolean;
}

interface PsPhysicalDisk {
  DeviceId?: number | string;
  FriendlyName?: string;
  SerialNumber?: string;
  MediaType?: string;
  BusType?: string;
  Size?: number;
  HealthStatus?: string;
  OperationalStatus?: string | string[];
}

interface PsVolume {
  DriveLetter?: string;
  FileSystemLabel?: string;
  FileSystem?: string;
  SizeRemaining?: number;
  Size?: number;
  HealthStatus?: string;
  Path?: string;
}

interface PsPartition {
  DiskNumber?: number;
  DriveLetter?: string;
  Size?: number;
  Type?: string;
}

interface PowerShellDiskPayload {
  Disks?: PsDisk[] | PsDisk;
  Physical?: PsPhysicalDisk[] | PsPhysicalDisk;
  Volumes?: PsVolume[] | PsVolume;
  Partitions?: PsPartition[] | PsPartition;
  DisksError?: string;
  PhysicalError?: string;
  VolumesError?: string;
  PartitionsError?: string;
}

interface WmicDisk {
  DeviceID?: string;
  MediaType?: string;
  Model?: string;
  Size?: string;
  Status?: string;
}

const UNKNOWN_SMART_MESSAGE = "SMART avancado indisponivel. Use smartmontools para detalhes.";

function asArray<T>(value: T[] | T | undefined): T[] {
  if (!value) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

function normalizeStatus(value: unknown): DiskHealthStatus {
  const text = Array.isArray(value) ? value.join(" ") : String(value ?? "");
  const normalized = text.toLowerCase();

  if (/(failed|failure|critical|unhealthy|bad|pred fail|lost communication)/.test(normalized)) {
    return "critical";
  }

  if (/(warning|degraded|stressed|caution|non-critical|in service)/.test(normalized)) {
    return "warning";
  }

  if (/(healthy|ok|online|running|normal)/.test(normalized)) {
    return "healthy";
  }

  return "unknown";
}

function statusLabel(status: DiskHealthStatus): string {
  switch (status) {
    case "healthy":
      return "Saudavel";
    case "warning":
      return "Atencao";
    case "critical":
      return "Critico";
    default:
      return "Desconhecido";
  }
}

function worstStatus(a: DiskHealthStatus, b: DiskHealthStatus): DiskHealthStatus {
  const weight: Record<DiskHealthStatus, number> = {
    healthy: 0,
    unknown: 1,
    warning: 2,
    critical: 3
  };

  return weight[b] > weight[a] ? b : a;
}

function normalizeKind(mediaType?: string, busType?: string, model?: string): DiskKind {
  const text = `${mediaType ?? ""} ${busType ?? ""} ${model ?? ""}`.toLowerCase();

  if (text.includes("usb")) {
    return "USB";
  }
  if (text.includes("nvme")) {
    return "NVMe";
  }
  if (text.includes("ssd") || text.includes("solid")) {
    return "SSD";
  }
  if (text.includes("hdd") || text.includes("hard disk") || text.includes("fixed")) {
    return "HDD";
  }

  return "Unknown";
}

function smartStatus(report: SmartReport): DiskHealthStatus {
  let status: DiskHealthStatus = report.overallPassed === false ? "critical" : "unknown";

  if (report.overallPassed === true) {
    status = "healthy";
  }

  for (const attribute of report.attributes) {
    if (attribute.status) {
      status = worstStatus(status, attribute.status);
    }
  }

  if ((report.temperatureC ?? 0) >= 65 || (report.reallocatedSectors ?? 0) >= 50) {
    status = worstStatus(status, "critical");
  } else if ((report.temperatureC ?? 0) >= 55 || (report.reallocatedSectors ?? 0) > 0 || (report.smartErrors ?? 0) > 0) {
    status = worstStatus(status, "warning");
  }

  if ((report.wearLevelPercent ?? 0) >= 95) {
    status = worstStatus(status, "critical");
  } else if ((report.wearLevelPercent ?? 0) >= 80) {
    status = worstStatus(status, "warning");
  }

  return status;
}

function buildHealthMessage(status: DiskHealthStatus, smartAvailable: boolean): string {
  if (!smartAvailable && status === "unknown") {
    return UNKNOWN_SMART_MESSAGE;
  }
  if (status === "critical") {
    return "Risco alto detectado. Evite transferencias para este disco.";
  }
  if (status === "warning") {
    return "Alguns indicadores pedem atencao antes de usar o disco como destino.";
  }
  if (status === "healthy") {
    return "Status basico indica funcionamento normal.";
  }
  return "Nao foi possivel determinar a saude com os comandos disponiveis.";
}

function parseJsonPayload(stdout: string): PowerShellDiskPayload {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return {};
  }

  return JSON.parse(trimmed) as PowerShellDiskPayload;
}

async function readWindowsDiskPayload(): Promise<PowerShellDiskPayload> {
  const script = `
$result = [ordered]@{}
try { $result.Disks = @(Get-Disk | Select-Object Number,FriendlyName,SerialNumber,BusType,PartitionStyle,HealthStatus,OperationalStatus,Size,IsBoot,IsSystem) } catch { $result.DisksError = $_.Exception.Message }
try { $result.Physical = @(Get-PhysicalDisk | Select-Object DeviceId,FriendlyName,SerialNumber,MediaType,BusType,Size,HealthStatus,OperationalStatus) } catch { $result.PhysicalError = $_.Exception.Message }
try { $result.Volumes = @(Get-Volume | Select-Object DriveLetter,FileSystemLabel,FileSystem,SizeRemaining,Size,HealthStatus,Path) } catch { $result.VolumesError = $_.Exception.Message }
try { $result.Partitions = @(Get-Partition | Select-Object DiskNumber,DriveLetter,Size,Type) } catch { $result.PartitionsError = $_.Exception.Message }
$result | ConvertTo-Json -Depth 8 -Compress
`;
  const { stdout } = await runPowerShell(script, 15000);
  return parseJsonPayload(stdout);
}

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      cells.push(current);
      current = "";
    } else {
      current += char;
    }
  }

  cells.push(current);
  return cells.map((cell) => cell.trim());
}

async function readWmicDisks(): Promise<DiskInfo[]> {
  const { stdout } = await runWmicDiskDrive(10000);
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const headerLine = lines.find((line) => /^Node,/i.test(line));
  if (!headerLine) {
    return [];
  }

  const header = parseCsvLine(headerLine);
  return lines
    .filter((line) => line !== headerLine && line.includes(","))
    .map((line, index) => {
      const row = parseCsvLine(line);
      const disk = header.reduce<WmicDisk>((accumulator, key, cellIndex) => {
        accumulator[key as keyof WmicDisk] = row[cellIndex];
        return accumulator;
      }, {});
      const status = normalizeStatus(disk.Status);
      const model = disk.Model || `Disco ${index}`;
      const mediaType = disk.MediaType;
      const sizeBytes = toNumber(disk.Size) ?? 0;
      return {
        id: `wmic-${index}`,
        index,
        model,
        serialNumber: disk.DeviceID,
        type: normalizeKind(mediaType, undefined, model),
        sizeBytes,
        usedBytes: undefined,
        freeBytes: undefined,
        status,
        statusLabel: statusLabel(status),
        healthMessage: buildHealthMessage(status, false),
        mediaType,
        volumes: [],
        smartAvailable: false,
        smartAttributes: []
      };
    });
}

function volumeForPartition(partition: PsPartition, volumeByLetter: Map<string, PsVolume>): VolumeInfo | undefined {
  const letter = partition.DriveLetter?.toString();
  if (!letter) {
    return undefined;
  }

  const volume = volumeByLetter.get(letter.toUpperCase());
  return {
    driveLetter: letter.toUpperCase(),
    label: volume?.FileSystemLabel,
    fileSystem: volume?.FileSystem,
    sizeBytes: toNumber(volume?.Size) ?? toNumber(partition.Size),
    freeBytes: toNumber(volume?.SizeRemaining),
    healthStatus: volume?.HealthStatus,
    path: volume?.Path
  };
}

function buildDisksFromPayload(payload: PowerShellDiskPayload): DiskInfo[] {
  const disks = asArray(payload.Disks);
  const physical = asArray(payload.Physical);
  const volumes = asArray(payload.Volumes);
  const partitions = asArray(payload.Partitions);
  const volumeByLetter = new Map(
    volumes
      .filter((volume) => volume.DriveLetter)
      .map((volume) => [String(volume.DriveLetter).toUpperCase(), volume])
  );

  const sources: PsDisk[] = disks.length > 0 ? disks : physical.map((item, index) => ({
    Number: typeof item.DeviceId === "number" ? item.DeviceId : index,
    FriendlyName: item.FriendlyName,
    SerialNumber: item.SerialNumber,
    BusType: item.BusType,
    HealthStatus: item.HealthStatus,
    OperationalStatus: item.OperationalStatus,
    Size: item.Size,
    IsBoot: undefined,
    IsSystem: undefined
  }));

  return sources.map((disk, index) => {
    const physicalMatch =
      physical.find((item) => item.SerialNumber && disk.SerialNumber && item.SerialNumber === disk.SerialNumber) ??
      physical[index];
    const mediaType = physicalMatch?.MediaType;
    const busType = disk.BusType ?? physicalMatch?.BusType;
    const model = disk.FriendlyName ?? physicalMatch?.FriendlyName ?? `Disco ${disk.Number ?? index}`;
    const basicStatus = worstStatus(normalizeStatus(disk.HealthStatus), normalizeStatus(disk.OperationalStatus));
    const diskNumber = typeof disk.Number === "number" ? disk.Number : index;
    const diskVolumes = partitions
      .filter((partition) => partition.DiskNumber === diskNumber)
      .map((partition) => volumeForPartition(partition, volumeByLetter))
      .filter((volume): volume is VolumeInfo => Boolean(volume));
    const freeBytes = diskVolumes.reduce((sum, volume) => sum + (volume.freeBytes ?? 0), 0);
    const volumeSizeBytes = diskVolumes.reduce((sum, volume) => sum + (volume.sizeBytes ?? 0), 0);
    const usedBytes = volumeSizeBytes > 0 ? volumeSizeBytes - freeBytes : undefined;

    return {
      id: `disk-${diskNumber}`,
      index: diskNumber,
      model,
      serialNumber: disk.SerialNumber ?? physicalMatch?.SerialNumber,
      type: normalizeKind(mediaType, busType, model),
      sizeBytes: toNumber(disk.Size) ?? toNumber(physicalMatch?.Size) ?? volumeSizeBytes,
      usedBytes,
      freeBytes: freeBytes > 0 ? freeBytes : undefined,
      status: basicStatus,
      statusLabel: statusLabel(basicStatus),
      healthMessage: buildHealthMessage(basicStatus, false),
      mediaType,
      busType,
      isBoot: disk.IsBoot,
      isSystem: disk.IsSystem,
      volumes: diskVolumes,
      smartAvailable: false,
      smartAttributes: []
    };
  });
}

async function enrichWithSmart(disks: DiskInfo[]): Promise<DiskInfo[]> {
  const detection = await detectSmartctl();
  if (!detection.installed) {
    return disks.map((disk) => ({
      ...disk,
      healthMessage: disk.healthMessage ?? UNKNOWN_SMART_MESSAGE
    }));
  }

  const devices = await listSmartDevices();
  if (devices.length === 0) {
    return disks.map((disk) => ({
      ...disk,
      healthMessage: "smartctl instalado, mas nenhum dispositivo SMART foi aberto. Talvez seja necessario executar como administrador."
    }));
  }

  const enriched: DiskInfo[] = [];
  for (const disk of disks) {
    const device = devices[disk.index] ?? devices[enriched.length];
    if (!device) {
      enriched.push(disk);
      continue;
    }

    const report = await readSmartReport(device);
    if (!report.available) {
      enriched.push({
        ...disk,
        healthMessage: report.message ?? disk.healthMessage
      });
      continue;
    }

    const combinedStatus = worstStatus(disk.status, smartStatus(report));
    enriched.push({
      ...disk,
      status: combinedStatus,
      statusLabel: statusLabel(combinedStatus),
      healthMessage: buildHealthMessage(combinedStatus, true),
      temperatureC: report.temperatureC,
      powerOnHours: report.powerOnHours,
      reallocatedSectors: report.reallocatedSectors,
      smartErrors: report.smartErrors,
      wearLevelPercent: report.wearLevelPercent,
      smartAvailable: true,
      smartAttributes: report.attributes
    });
  }

  return enriched;
}

export async function getDisks(): Promise<DiskInfo[]> {
  try {
    const payload = await readWindowsDiskPayload();
    const disks = buildDisksFromPayload(payload);
    if (disks.length > 0) {
      return enrichWithSmart(disks);
    }
  } catch {
    // WMIC fallback below covers older Windows or restricted PowerShell sessions.
  }

  try {
    const disks = await readWmicDisks();
    return enrichWithSmart(disks);
  } catch (error) {
    return [
      {
        id: "unknown",
        index: 0,
        model: "Nenhum disco detectado",
        type: "Unknown",
        sizeBytes: 0,
        status: "unknown",
        statusLabel: statusLabel("unknown"),
        healthMessage: error instanceof Error ? error.message : "Nao foi possivel consultar os discos.",
        volumes: [],
        smartAvailable: false,
        smartAttributes: []
      }
    ];
  }
}

export async function getDiskHealth(): Promise<DiskHealthSummary[]> {
  const disks = await getDisks();
  return disks.map((disk) => ({
    id: disk.id,
    model: disk.model,
    status: disk.status,
    statusLabel: disk.statusLabel,
    message: disk.healthMessage,
    temperatureC: disk.temperatureC,
    smartAvailable: disk.smartAvailable
  }));
}

export async function getDiskById(id: string): Promise<DiskInfo | undefined> {
  const disks = await getDisks();
  return disks.find((disk) => disk.id === id);
}

export async function getFreeSpace(pathOrDrive: string): Promise<FreeSpaceInfo> {
  const drive = getDriveLetter(pathOrDrive);
  if (!drive) {
    throw new Error("Nao foi possivel identificar a unidade do destino.");
  }

  const script = `
$drive = Get-PSDrive -Name '${drive}' -ErrorAction Stop
[pscustomobject]@{
  drive = $drive.Name
  root = $drive.Root
  freeBytes = [int64]$drive.Free
  usedBytes = [int64]$drive.Used
  totalBytes = [int64]($drive.Free + $drive.Used)
} | ConvertTo-Json -Compress
`;

  const { stdout } = await runPowerShell(script, 8000);
  const parsed = JSON.parse(stdout.trim()) as FreeSpaceInfo;
  return parsed;
}

export async function getDestinationHealth(pathOrDrive: string): Promise<DiskHealthStatus | undefined> {
  const drive = getDriveLetter(pathOrDrive);
  if (!drive) {
    return undefined;
  }

  const disks = await getDisks();
  return disks.find((disk) => disk.volumes.some((volume) => volume.driveLetter === drive))?.status;
}

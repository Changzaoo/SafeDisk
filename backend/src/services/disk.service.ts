import type {
  DiskHealthStatus,
  DiskHealthSummary,
  DiskInfo,
  DiskKind,
  FreeSpaceInfo,
  SmartAttribute,
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
  UniqueId?: string;
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

interface PsReliabilityCounter {
  DeviceId?: number | string;
  FriendlyName?: string;
  SerialNumber?: string;
  UniqueId?: string;
  Temperature?: number;
  TemperatureMax?: number;
  PowerOnHours?: number;
  ReadErrorsTotal?: number;
  WriteErrorsTotal?: number;
  Wear?: number;
  StartStopCycleCount?: number;
  LoadUnloadCycleCount?: number;
  Error?: string;
}

interface PsSmartPredictData {
  InstanceName?: string;
  VendorSpecific?: number[] | number;
}

interface PsSmartPredictStatus {
  InstanceName?: string;
  PredictFailure?: boolean;
  Reason?: number;
}

interface PowerShellDiskPayload {
  Disks?: PsDisk[] | PsDisk;
  Physical?: PsPhysicalDisk[] | PsPhysicalDisk;
  Volumes?: PsVolume[] | PsVolume;
  Partitions?: PsPartition[] | PsPartition;
  Reliability?: PsReliabilityCounter[] | PsReliabilityCounter;
  SmartPredictData?: PsSmartPredictData[] | PsSmartPredictData;
  SmartPredictStatus?: PsSmartPredictStatus[] | PsSmartPredictStatus;
  DisksError?: string;
  PhysicalError?: string;
  VolumesError?: string;
  PartitionsError?: string;
  ReliabilityError?: string;
  SmartPredictDataError?: string;
  SmartPredictStatusError?: string;
}

interface WmicDisk {
  DeviceID?: string;
  MediaType?: string;
  Model?: string;
  Size?: string;
  Status?: string;
}

interface NativeSmartAttribute extends SmartAttribute {
  rawNumber?: number;
  rawBytes: number[];
}

interface NativeSmartReport extends SmartReport {
  instanceName?: string;
}

const UNKNOWN_SMART_MESSAGE = "Indicadores avancados indisponiveis. Usando dados basicos do Windows.";

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

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const parsed = toNumber(value);
    if (parsed != null) {
      return parsed;
    }
  }

  return undefined;
}

function normalizeIdentifier(value: unknown): string {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function identifierMatches(source: unknown, target: unknown): boolean {
  const normalizedSource = normalizeIdentifier(source);
  const normalizedTarget = normalizeIdentifier(target);
  return Boolean(
    normalizedSource &&
      normalizedTarget &&
      (normalizedSource.includes(normalizedTarget) || normalizedTarget.includes(normalizedSource))
  );
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

function combineStatus(...statuses: DiskHealthStatus[]): DiskHealthStatus {
  let combined: DiskHealthStatus = "unknown";

  for (const status of statuses) {
    if (status === "unknown") {
      continue;
    }

    combined = combined === "unknown" ? status : worstStatus(combined, status);
  }

  return combined;
}

function hasReliabilityData(counter: PsReliabilityCounter | undefined): boolean {
  return Boolean(
    counter &&
      !counter.Error &&
      [
        counter.Temperature,
        counter.TemperatureMax,
        counter.PowerOnHours,
        counter.ReadErrorsTotal,
        counter.WriteErrorsTotal,
        counter.Wear,
        counter.StartStopCycleCount,
        counter.LoadUnloadCycleCount
      ].some((value) => toNumber(value) != null)
  );
}

function reliabilityStatus(counter: PsReliabilityCounter | undefined): DiskHealthStatus {
  if (!hasReliabilityData(counter)) {
    return "unknown";
  }

  let status: DiskHealthStatus = "healthy";
  const temperature = toNumber(counter?.Temperature);
  const wear = toNumber(counter?.Wear);
  const readErrors = toNumber(counter?.ReadErrorsTotal) ?? 0;
  const writeErrors = toNumber(counter?.WriteErrorsTotal) ?? 0;

  if ((temperature ?? 0) >= 65) {
    status = worstStatus(status, "critical");
  } else if ((temperature ?? 0) >= 55) {
    status = worstStatus(status, "warning");
  }

  if ((wear ?? 0) >= 95) {
    status = worstStatus(status, "critical");
  } else if ((wear ?? 0) >= 80) {
    status = worstStatus(status, "warning");
  }

  if (readErrors > 0 || writeErrors > 0) {
    status = worstStatus(status, "warning");
  }

  return status;
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

const SMART_ATTRIBUTE_NAMES: Record<number, string> = {
  1: "Read_Error_Rate",
  5: "Reallocated_Sector_Ct",
  9: "Power_On_Hours",
  12: "Power_Cycle_Count",
  177: "Wear_Leveling_Count",
  181: "Program_Fail_Count",
  182: "Erase_Fail_Count",
  187: "Reported_Uncorrect",
  190: "Airflow_Temperature_Cel",
  194: "Temperature_Celsius",
  195: "Hardware_ECC_Recovered",
  197: "Current_Pending_Sector",
  198: "Offline_Uncorrectable",
  199: "UDMA_CRC_Error_Count",
  202: "Percent_Lifetime_Remain",
  231: "SSD_Life_Left",
  233: "Media_Wearout_Indicator",
  241: "Total_LBAs_Written",
  242: "Total_LBAs_Read"
};

function smartAttributeName(id: number): string {
  return SMART_ATTRIBUTE_NAMES[id] ?? `SMART_${id}`;
}

function rawBytesToNumber(bytes: number[]): number | undefined {
  if (bytes.length === 0) {
    return undefined;
  }

  return bytes.reduce((sum, byte, index) => sum + byte * 2 ** (index * 8), 0);
}

function toByteArray(value: number[] | number | undefined): number[] {
  if (Array.isArray(value)) {
    return value.filter((item) => Number.isInteger(item) && item >= 0 && item <= 255);
  }
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 255) {
    return [value];
  }
  return [];
}

function plausibleTemperature(value: number | undefined): number | undefined {
  return value != null && value >= 0 && value <= 120 ? value : undefined;
}

function nativeAttributeStatus(id: number, rawNumber: number | undefined, temperatureC: number | undefined): DiskHealthStatus | undefined {
  if ([5, 187, 197, 198].includes(id)) {
    if ((rawNumber ?? 0) >= 50) {
      return "critical";
    }
    if ((rawNumber ?? 0) > 0) {
      return "warning";
    }
  }

  if ([190, 194].includes(id)) {
    if ((temperatureC ?? 0) >= 65) {
      return "critical";
    }
    if ((temperatureC ?? 0) >= 55) {
      return "warning";
    }
  }

  if (id === 199 && (rawNumber ?? 0) > 0) {
    return "warning";
  }

  return undefined;
}

function parseNativeSmartAttributes(data: PsSmartPredictData): NativeSmartAttribute[] {
  const bytes = toByteArray(data.VendorSpecific);
  const attributes: NativeSmartAttribute[] = [];

  for (let offset = 2; offset + 12 <= bytes.length; offset += 12) {
    const id = bytes[offset];
    if (!id) {
      continue;
    }

    const rawBytes = bytes.slice(offset + 5, offset + 11);
    const rawNumber = rawBytesToNumber(rawBytes);
    const temperatureC = [190, 194].includes(id) ? plausibleTemperature(rawBytes[0]) : undefined;
    attributes.push({
      id,
      name: smartAttributeName(id),
      value: bytes[offset + 3],
      worst: bytes[offset + 4],
      raw: String(temperatureC ?? rawNumber ?? ""),
      rawNumber,
      rawBytes,
      status: nativeAttributeStatus(id, rawNumber, temperatureC)
    });
  }

  return attributes;
}

function findAttributeNumber(attributes: NativeSmartAttribute[], ids: number[]): number | undefined {
  return attributes.find((attribute) => attribute.id != null && ids.includes(attribute.id))?.rawNumber;
}

function findAttributeTemperature(attributes: NativeSmartAttribute[]): number | undefined {
  for (const attribute of attributes) {
    if (attribute.id != null && [190, 194].includes(attribute.id)) {
      const temperature = plausibleTemperature(attribute.rawBytes[0]);
      if (temperature != null) {
        return temperature;
      }
    }
  }

  return undefined;
}

function findSmartPredictStatus(data: PsSmartPredictData, statuses: PsSmartPredictStatus[]): PsSmartPredictStatus | undefined {
  return statuses.find((status) => normalizeIdentifier(status.InstanceName) === normalizeIdentifier(data.InstanceName));
}

function buildNativeSmartReport(data: PsSmartPredictData, status?: PsSmartPredictStatus): NativeSmartReport | undefined {
  const attributes = parseNativeSmartAttributes(data);
  if (attributes.length === 0 && status?.PredictFailure == null) {
    return undefined;
  }

  const reallocatedSectors = findAttributeNumber(attributes, [5]);
  const pendingSectors = findAttributeNumber(attributes, [197]);
  const uncorrectableSectors = findAttributeNumber(attributes, [187, 198]);
  const crcErrors = findAttributeNumber(attributes, [199]);
  const smartErrors = [pendingSectors, uncorrectableSectors, crcErrors]
    .filter((value): value is number => value != null)
    .reduce((sum, value) => sum + value, 0);

  return {
    available: true,
    instanceName: data.InstanceName,
    overallPassed: status?.PredictFailure == null ? undefined : !status.PredictFailure,
    temperatureC: findAttributeTemperature(attributes),
    powerOnHours: findAttributeNumber(attributes, [9]),
    reallocatedSectors,
    smartErrors: smartErrors > 0 ? smartErrors : undefined,
    attributes
  };
}

function nativeSmartReportsFromPayload(payload: PowerShellDiskPayload): NativeSmartReport[] {
  const statuses = asArray(payload.SmartPredictStatus);
  return asArray(payload.SmartPredictData)
    .map((data) => buildNativeSmartReport(data, findSmartPredictStatus(data, statuses)))
    .filter((report): report is NativeSmartReport => Boolean(report));
}

function findReliabilityCounter(
  disk: PsDisk,
  physicalDisk: PsPhysicalDisk | undefined,
  counters: PsReliabilityCounter[],
  index: number
): PsReliabilityCounter | undefined {
  const usableCounters = counters.filter((counter) => hasReliabilityData(counter));
  return (
    usableCounters.find(
      (counter) =>
        String(counter.DeviceId ?? "") === String(physicalDisk?.DeviceId ?? disk.Number ?? "") ||
        String(counter.DeviceId ?? "") === String(disk.Number ?? "")
    ) ??
    usableCounters.find(
      (counter) =>
        identifierMatches(counter.SerialNumber, disk.SerialNumber ?? physicalDisk?.SerialNumber) ||
        identifierMatches(counter.UniqueId, physicalDisk?.UniqueId) ||
        identifierMatches(counter.FriendlyName, disk.FriendlyName ?? physicalDisk?.FriendlyName)
    ) ??
    usableCounters[index]
  );
}

function findNativeSmartReport(
  disk: PsDisk,
  physicalDisk: PsPhysicalDisk | undefined,
  reports: NativeSmartReport[],
  index: number
): NativeSmartReport | undefined {
  return (
    reports.find(
      (report) =>
        identifierMatches(report.instanceName, disk.SerialNumber ?? physicalDisk?.SerialNumber) ||
        identifierMatches(report.instanceName, physicalDisk?.UniqueId) ||
        identifierMatches(report.instanceName, disk.FriendlyName ?? physicalDisk?.FriendlyName)
    ) ?? reports[index]
  );
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
try { $result.Physical = @(Get-PhysicalDisk | Select-Object DeviceId,FriendlyName,SerialNumber,UniqueId,MediaType,BusType,Size,HealthStatus,OperationalStatus) } catch { $result.PhysicalError = $_.Exception.Message }
try { $result.Volumes = @(Get-Volume | Select-Object DriveLetter,FileSystemLabel,FileSystem,SizeRemaining,Size,HealthStatus,Path) } catch { $result.VolumesError = $_.Exception.Message }
try { $result.Partitions = @(Get-Partition | Select-Object DiskNumber,DriveLetter,Size,Type) } catch { $result.PartitionsError = $_.Exception.Message }
try {
  $result.Reliability = @(Get-PhysicalDisk | ForEach-Object {
    $disk = $_
    try {
      $counter = $disk | Get-StorageReliabilityCounter
      [pscustomobject]@{
        DeviceId = $disk.DeviceId
        FriendlyName = $disk.FriendlyName
        SerialNumber = $disk.SerialNumber
        UniqueId = $disk.UniqueId
        Temperature = $counter.Temperature
        TemperatureMax = $counter.TemperatureMax
        PowerOnHours = $counter.PowerOnHours
        ReadErrorsTotal = $counter.ReadErrorsTotal
        WriteErrorsTotal = $counter.WriteErrorsTotal
        Wear = $counter.Wear
        StartStopCycleCount = $counter.StartStopCycleCount
        LoadUnloadCycleCount = $counter.LoadUnloadCycleCount
      }
    } catch {
      [pscustomobject]@{
        DeviceId = $disk.DeviceId
        FriendlyName = $disk.FriendlyName
        SerialNumber = $disk.SerialNumber
        UniqueId = $disk.UniqueId
        Error = $_.Exception.Message
      }
    }
  })
} catch { $result.ReliabilityError = $_.Exception.Message }
try { $result.SmartPredictData = @(Get-CimInstance -Namespace root\\wmi -ClassName MSStorageDriver_FailurePredictData | Select-Object InstanceName,VendorSpecific) } catch { $result.SmartPredictDataError = $_.Exception.Message }
try { $result.SmartPredictStatus = @(Get-CimInstance -Namespace root\\wmi -ClassName MSStorageDriver_FailurePredictStatus | Select-Object InstanceName,PredictFailure,Reason) } catch { $result.SmartPredictStatusError = $_.Exception.Message }
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
  const reliabilityCounters = asArray(payload.Reliability);
  const nativeSmartReports = nativeSmartReportsFromPayload(payload);
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
      physical.find((item) => String(item.DeviceId ?? "") === String(disk.Number ?? "")) ??
      physical.find((item) => item.SerialNumber && disk.SerialNumber && item.SerialNumber === disk.SerialNumber) ??
      physical[index];
    const reliabilityMatch = findReliabilityCounter(disk, physicalMatch, reliabilityCounters, index);
    const nativeSmartReport = findNativeSmartReport(disk, physicalMatch, nativeSmartReports, index);
    const mediaType = physicalMatch?.MediaType;
    const busType = disk.BusType ?? physicalMatch?.BusType;
    const model = disk.FriendlyName ?? physicalMatch?.FriendlyName ?? `Disco ${disk.Number ?? index}`;
    const basicStatus = combineStatus(normalizeStatus(disk.HealthStatus), normalizeStatus(disk.OperationalStatus));
    const advancedStatus = combineStatus(reliabilityStatus(reliabilityMatch), nativeSmartReport ? smartStatus(nativeSmartReport) : "unknown");
    const combinedStatus = combineStatus(basicStatus, advancedStatus);
    const diskNumber = typeof disk.Number === "number" ? disk.Number : index;
    const diskVolumes = partitions
      .filter((partition) => partition.DiskNumber === diskNumber)
      .map((partition) => volumeForPartition(partition, volumeByLetter))
      .filter((volume): volume is VolumeInfo => Boolean(volume));
    const freeBytes = diskVolumes.reduce((sum, volume) => sum + (volume.freeBytes ?? 0), 0);
    const volumeSizeBytes = diskVolumes.reduce((sum, volume) => sum + (volume.sizeBytes ?? 0), 0);
    const usedBytes = volumeSizeBytes > 0 ? volumeSizeBytes - freeBytes : undefined;
    const readErrors = toNumber(reliabilityMatch?.ReadErrorsTotal) ?? 0;
    const writeErrors = toNumber(reliabilityMatch?.WriteErrorsTotal) ?? 0;
    const reliabilityErrors = readErrors + writeErrors;
    const hasAdvancedData = hasReliabilityData(reliabilityMatch) || Boolean(nativeSmartReport?.available);

    return {
      id: `disk-${diskNumber}`,
      index: diskNumber,
      model,
      serialNumber: disk.SerialNumber ?? physicalMatch?.SerialNumber,
      type: normalizeKind(mediaType, busType, model),
      sizeBytes: toNumber(disk.Size) ?? toNumber(physicalMatch?.Size) ?? volumeSizeBytes,
      usedBytes,
      freeBytes: freeBytes > 0 ? freeBytes : undefined,
      status: combinedStatus,
      statusLabel: statusLabel(combinedStatus),
      healthMessage: buildHealthMessage(combinedStatus, hasAdvancedData),
      temperatureC: firstNumber(reliabilityMatch?.Temperature, nativeSmartReport?.temperatureC),
      powerOnHours: firstNumber(reliabilityMatch?.PowerOnHours, nativeSmartReport?.powerOnHours),
      reallocatedSectors: nativeSmartReport?.reallocatedSectors,
      smartErrors: firstNumber(nativeSmartReport?.smartErrors, reliabilityErrors > 0 ? reliabilityErrors : undefined),
      wearLevelPercent: firstNumber(reliabilityMatch?.Wear, nativeSmartReport?.wearLevelPercent),
      mediaType,
      busType,
      isBoot: disk.IsBoot,
      isSystem: disk.IsSystem,
      volumes: diskVolumes,
      smartAvailable: hasAdvancedData,
      smartAttributes: nativeSmartReport?.attributes ?? []
    };
  });
}

async function enrichWithSmart(disks: DiskInfo[]): Promise<DiskInfo[]> {
  const detection = await detectSmartctl();
  if (!detection.installed) {
    return disks;
  }

  const devices = await listSmartDevices();
  if (devices.length === 0) {
    return disks;
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

    const combinedStatus = combineStatus(disk.status, smartStatus(report));
    enriched.push({
      ...disk,
      status: combinedStatus,
      statusLabel: statusLabel(combinedStatus),
      healthMessage: buildHealthMessage(combinedStatus, true),
      temperatureC: report.temperatureC ?? disk.temperatureC,
      powerOnHours: report.powerOnHours ?? disk.powerOnHours,
      reallocatedSectors: report.reallocatedSectors ?? disk.reallocatedSectors,
      smartErrors: report.smartErrors ?? disk.smartErrors,
      wearLevelPercent: report.wearLevelPercent ?? disk.wearLevelPercent,
      smartAvailable: true,
      smartAttributes: report.attributes.length > 0 ? report.attributes : disk.smartAttributes
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

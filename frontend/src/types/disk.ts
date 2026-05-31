export type DiskHealthStatus = "healthy" | "warning" | "critical" | "unknown";
export type DiskKind = "HDD" | "SSD" | "NVMe" | "USB" | "Unknown";

export interface VolumeInfo {
  driveLetter?: string;
  label?: string;
  fileSystem?: string;
  sizeBytes?: number;
  freeBytes?: number;
  healthStatus?: string;
  path?: string;
}

export interface SmartAttribute {
  id?: number;
  name: string;
  value?: number;
  worst?: number;
  threshold?: number;
  raw?: string;
  status?: DiskHealthStatus;
}

export interface DiskInfo {
  id: string;
  index: number;
  model: string;
  serialNumber?: string;
  type: DiskKind;
  sizeBytes: number;
  usedBytes?: number;
  freeBytes?: number;
  status: DiskHealthStatus;
  statusLabel: string;
  healthMessage?: string;
  temperatureC?: number;
  powerOnHours?: number;
  reallocatedSectors?: number;
  smartErrors?: number;
  wearLevelPercent?: number;
  mediaType?: string;
  busType?: string;
  isSystem?: boolean;
  isBoot?: boolean;
  volumes: VolumeInfo[];
  smartAvailable: boolean;
  smartAttributes: SmartAttribute[];
}

export interface SmartctlDetection {
  installed: boolean;
  version?: string;
  error?: string;
}

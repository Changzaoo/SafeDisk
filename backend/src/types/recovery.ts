import type { DiskHealthStatus } from "./disk.js";

export type RecoveryProblem =
  | "deleted-files"
  | "emptied-trash"
  | "formatted-device"
  | "asks-format"
  | "device-not-open"
  | "missing-files"
  | "slow-device"
  | "disk-image";

export type RecoveryMode = "quick" | "deep" | "health" | "safe-copy" | "image" | "demo";

export type RecoveryOriginKind = "folder" | "drive" | "removable" | "external" | "image" | "backup" | "unknown";

export type RecoveryJobStatus = "queued" | "running" | "completed" | "failed" | "canceled" | "simulation";

export type RecoveryCategory = "images" | "documents" | "videos" | "audios" | "archives" | "others";

export interface RecoveryLocation {
  id: string;
  label: string;
  path: string;
  kind: RecoveryOriginKind;
  sizeBytes?: number;
  freeBytes?: number;
  warning?: string;
}

export interface RecoveryPathValidation {
  valid: boolean;
  warnings: string[];
  errors: string[];
  originDrive?: string;
  destinationDrive?: string;
}

export interface RecoveryHealthCheck {
  status: DiskHealthStatus;
  label: "Parece saudavel" | "Atencao: pode ter problemas" | "Risco alto: recomendamos criar uma copia segura antes" | "Nao foi possivel verificar";
  message: string;
  advanced: {
    model?: string;
    sizeBytes?: number;
    type?: string;
    technicalStatus?: string;
    temperatureC?: number;
    alerts: string[];
    logs: string[];
  };
}

export interface RecoveryStartRequest {
  problem: RecoveryProblem;
  originPath: string;
  destinationPath: string;
  mode: RecoveryMode;
  extensions?: string[];
  includeCommonFolders?: boolean;
  demo?: boolean;
}

export interface RecoveryResultFile {
  id: string;
  name: string;
  path: string;
  type: string;
  category: RecoveryCategory;
  sizeBytes: number;
  saved: boolean;
  sourceHint?: string;
  message?: string;
}

export interface RecoveryJobSnapshot {
  jobId: string;
  status: RecoveryJobStatus;
  createdAt: string;
  updatedAt: string;
  problem: RecoveryProblem;
  mode: RecoveryMode;
  originPath: string;
  destinationPath: string;
  phase: string;
  progress: number;
  foundCount: number;
  savedCount: number;
  totalBytes?: number;
  processedBytes?: number;
  currentItem?: string;
  fileTypes: Record<string, number>;
  results: RecoveryResultFile[];
  warnings: string[];
  errors: string[];
  advancedLogs: string[];
  cancelRequested: boolean;
  reportTxtPath?: string;
  reportJsonPath?: string;
}

export interface RecoveryHistoryRecord {
  id: string;
  timestamp: string;
  problem: RecoveryProblem;
  originPath: string;
  destinationPath: string;
  mode: RecoveryMode;
  foundCount: number;
  savedCount: number;
  status: "concluido" | "cancelado" | "erro";
  notes?: string;
}

export interface RecoveryToolInfo {
  id: string;
  label: string;
  installed: boolean;
  path?: string;
  message: string;
}

export interface RecoveryToolsDetection {
  windowsFileRecovery: RecoveryToolInfo;
  photoRec: RecoveryToolInfo;
  testDisk: RecoveryToolInfo;
  proprietary: RecoveryToolInfo[];
}

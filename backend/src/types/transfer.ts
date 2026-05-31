export type ConflictMode = "rename" | "replace" | "skip" | "compare";

export type PreviewAction = "move" | "rename" | "replace" | "skip" | "conflict" | "unavailable";

export type JobStatus = "queued" | "running" | "paused" | "completed" | "failed" | "canceled" | "simulation";

export type FileTransferStatus =
  | "queued"
  | "copying"
  | "verifying"
  | "finalizing"
  | "success"
  | "skipped"
  | "error"
  | "canceled"
  | "simulated";

export interface TransferRequest {
  sources: string[];
  destination: string;
  conflictMode: ConflictMode;
  simulation: boolean;
  safetyMarginPercent?: number;
  safetyMarginBytes?: number;
}

export interface PreviewFile {
  source: string;
  destination?: string;
  relativePath?: string;
  sizeBytes: number;
  action: PreviewAction;
  existsAtDestination: boolean;
  hashMatch?: boolean;
  message?: string;
}

export interface TransferPreview {
  sources: string[];
  destination: string;
  conflictMode: ConflictMode;
  simulation: boolean;
  files: PreviewFile[];
  totalBytes: number;
  fileCount: number;
  conflicts: PreviewFile[];
  unavailable: PreviewFile[];
  destinationExists: boolean;
  destinationFreeBeforeBytes?: number;
  destinationFreeAfterBytes?: number;
  safetyMarginBytes?: number;
  hasEnoughSpace: boolean;
  destinationHealthStatus?: string;
  warnings: string[];
}

export interface TransferFileProgress {
  id: string;
  source: string;
  destination: string;
  sizeBytes: number;
  transferredBytes: number;
  status: FileTransferStatus;
  hashSource?: string;
  hashDestination?: string;
  message?: string;
}

export interface TransferJobSnapshot {
  jobId: string;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  destination: string;
  conflictMode: ConflictMode;
  simulation: boolean;
  totalBytes: number;
  transferredBytes: number;
  currentFileId?: string;
  files: TransferFileProgress[];
  errors: string[];
  paused: boolean;
  cancelRequested: boolean;
}

export interface HistoryRecord {
  id: string;
  timestamp: string;
  sourcePath: string;
  destinationPath: string;
  sizeBytes: number;
  hashSource?: string;
  hashDestination?: string;
  status: "success" | "error" | "canceled";
  errorMessage?: string;
}

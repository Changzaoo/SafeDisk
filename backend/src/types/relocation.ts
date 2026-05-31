import type { JobStatus } from "./transfer.js";

export type LinkType = "junction" | "symlink";

export interface RelocationRequest {
  source: string;
  destinationParent: string;
  destinationName?: string;
  linkType: LinkType;
  simulation: boolean;
  keepBackup: boolean;
  safetyMarginPercent?: number;
  safetyMarginBytes?: number;
}

export interface RelocationPreview {
  source: string;
  destinationParent: string;
  destinationPath: string;
  linkPath: string;
  temporaryPath: string;
  backupPath: string;
  linkType: LinkType;
  simulation: boolean;
  keepBackup: boolean;
  sourceExists: boolean;
  sourceIsDirectory: boolean;
  destinationParentExists: boolean;
  destinationAvailable: boolean;
  temporaryAvailable: boolean;
  fileCount: number;
  directoryCount: number;
  symlinkCount: number;
  totalBytes: number;
  destinationFreeBeforeBytes?: number;
  destinationFreeAfterBytes?: number;
  safetyMarginBytes?: number;
  hasEnoughSpace: boolean;
  warnings: string[];
}

export interface RelocationJobSnapshot {
  jobId: string;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  source: string;
  destinationPath: string;
  linkPath: string;
  backupPath: string;
  linkType: LinkType;
  simulation: boolean;
  keepBackup: boolean;
  totalBytes: number;
  copiedBytes: number;
  fileCount: number;
  processedFiles: number;
  currentFile?: string;
  stage: string;
  errors: string[];
  cancelRequested: boolean;
}

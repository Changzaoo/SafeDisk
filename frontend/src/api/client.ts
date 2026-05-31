import type { DiskInfo, SmartctlDetection } from "../types/disk";
import type { RelocationJobSnapshot, RelocationPreview, RelocationRequest } from "../types/relocation";
import type { HistoryRecord, TransferJobSnapshot, TransferPreview, TransferRequest } from "../types/transfer";

const API_BASE_URL =
  import.meta.env.VITE_API_URL ?? (import.meta.env.DEV ? "http://localhost:3333" : "https://safedisk.onrender.com");

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {})
    },
    ...init
  });

  if (!response.ok) {
    let message = `Erro HTTP ${response.status}`;
    try {
      const payload = (await response.json()) as { error?: string };
      message = payload.error ?? message;
    } catch {
      message = await response.text();
    }
    throw new Error(message);
  }

  return (await response.json()) as T;
}

export const api = {
  baseUrl: API_BASE_URL,
  getDisks: () => request<DiskInfo[]>("/api/disks"),
  getDisk: (id: string) => request<DiskInfo>(`/api/disks/${encodeURIComponent(id)}`),
  getSmartctl: () => request<SmartctlDetection>("/api/disks/smartctl"),
  previewTransfer: (body: TransferRequest) =>
    request<TransferPreview>("/api/transfer/preview", {
      method: "POST",
      body: JSON.stringify(body)
    }),
  startTransfer: (body: TransferRequest) =>
    request<TransferJobSnapshot>("/api/transfer/start", {
      method: "POST",
      body: JSON.stringify(body)
    }),
  getTransferStatus: (jobId: string) => request<TransferJobSnapshot>(`/api/transfer/status/${encodeURIComponent(jobId)}`),
  cancelTransfer: (jobId: string) =>
    request<TransferJobSnapshot>(`/api/transfer/cancel/${encodeURIComponent(jobId)}`, { method: "POST" }),
  pauseTransfer: (jobId: string) =>
    request<TransferJobSnapshot>(`/api/transfer/pause/${encodeURIComponent(jobId)}`, { method: "POST" }),
  resumeTransfer: (jobId: string) =>
    request<TransferJobSnapshot>(`/api/transfer/resume/${encodeURIComponent(jobId)}`, { method: "POST" }),
  cleanupPartials: (root: string, olderThanHours: number) =>
    request<{ deleted: string[]; skipped: string[] }>("/api/transfer/cleanup-partials", {
      method: "POST",
      body: JSON.stringify({ root, olderThanHours })
    }),
  previewRelocation: (body: RelocationRequest) =>
    request<RelocationPreview>("/api/relocation/preview", {
      method: "POST",
      body: JSON.stringify(body)
    }),
  startRelocation: (body: RelocationRequest) =>
    request<RelocationJobSnapshot>("/api/relocation/start", {
      method: "POST",
      body: JSON.stringify(body)
    }),
  getRelocationStatus: (jobId: string) => request<RelocationJobSnapshot>(`/api/relocation/status/${encodeURIComponent(jobId)}`),
  cancelRelocation: (jobId: string) =>
    request<RelocationJobSnapshot>(`/api/relocation/cancel/${encodeURIComponent(jobId)}`, { method: "POST" }),
  getHistory: () => request<HistoryRecord[]>("/api/history"),
  historyExportUrl: (format: "json" | "csv") => `${API_BASE_URL}/api/history/export?format=${format}`
};

import type { DiskInfo, SmartctlDetection } from "../types/disk";
import type { RelocationJobSnapshot, RelocationPreview, RelocationRequest } from "../types/relocation";
import type { HistoryRecord, TransferJobSnapshot, TransferPreview, TransferRequest } from "../types/transfer";

const LOCAL_API_DEFAULT_URL = "http://localhost:3335";
const CLOUD_API_BASE_URL = import.meta.env.VITE_CLOUD_API_URL ?? "https://safedisk.onrender.com";
const API_BASE_URL_STORAGE_KEY = "safe-disk-api-url";
const API_BASE_URL_USER_SET_KEY = "safe-disk-api-url-user-set";
const LEGACY_CONFLICTING_LOCAL_URLS = new Set(["http://localhost:3333", "http://127.0.0.1:3333"]);

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function normalizeDefaultApiBaseUrl(value: string | undefined): string {
  const normalized = normalizeBaseUrl(value ?? LOCAL_API_DEFAULT_URL);
  return LEGACY_CONFLICTING_LOCAL_URLS.has(normalized) ? LOCAL_API_DEFAULT_URL : normalized;
}

const DEFAULT_API_BASE_URL = normalizeDefaultApiBaseUrl(import.meta.env.VITE_DEFAULT_API_URL);
const LOCAL_API_CANDIDATES = [
  DEFAULT_API_BASE_URL,
  "http://localhost:3336",
  "http://localhost:3340",
  "http://127.0.0.1:3335",
  "http://127.0.0.1:3336",
  "http://127.0.0.1:3340",
  "http://localhost:3341",
  "http://127.0.0.1:3341"
];

export function getApiBaseUrl(): string {
  if (typeof window === "undefined") {
    return DEFAULT_API_BASE_URL;
  }

  const stored = window.localStorage.getItem(API_BASE_URL_STORAGE_KEY);
  const normalizedStored = stored ? normalizeBaseUrl(stored) : undefined;
  const wasUserSet = window.localStorage.getItem(API_BASE_URL_USER_SET_KEY) === "1";
  if (normalizedStored && LEGACY_CONFLICTING_LOCAL_URLS.has(normalizedStored)) {
    window.localStorage.removeItem(API_BASE_URL_STORAGE_KEY);
    window.localStorage.removeItem(API_BASE_URL_USER_SET_KEY);
    return DEFAULT_API_BASE_URL;
  }

  if (normalizedStored === CLOUD_API_BASE_URL && !wasUserSet) {
    return DEFAULT_API_BASE_URL;
  }

  return normalizedStored ?? DEFAULT_API_BASE_URL;
}

function wasApiBaseUrlUserSet(): boolean {
  return typeof window !== "undefined" && window.localStorage.getItem(API_BASE_URL_USER_SET_KEY) === "1";
}

function rememberDetectedApiBaseUrl(value: string): void {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(API_BASE_URL_STORAGE_KEY, normalizeBaseUrl(value));
  window.localStorage.removeItem(API_BASE_URL_USER_SET_KEY);
  window.dispatchEvent(new Event("safe-disk-api-url-changed"));
}

export function setApiBaseUrl(value: string): string {
  const normalized = normalizeBaseUrl(value);
  window.localStorage.setItem(API_BASE_URL_STORAGE_KEY, normalized);
  window.localStorage.setItem(API_BASE_URL_USER_SET_KEY, "1");
  window.dispatchEvent(new Event("safe-disk-api-url-changed"));
  return normalized;
}

export function resetApiBaseUrl(): string {
  window.localStorage.removeItem(API_BASE_URL_STORAGE_KEY);
  window.localStorage.removeItem(API_BASE_URL_USER_SET_KEY);
  window.dispatchEvent(new Event("safe-disk-api-url-changed"));
  return DEFAULT_API_BASE_URL;
}

export function isUsingCloudBackend(): boolean {
  return getApiBaseUrl().includes("onrender.com");
}

function isLocalDefaultMode(baseUrl: string): boolean {
  return !wasApiBaseUrlUserSet() && LOCAL_API_CANDIDATES.includes(baseUrl);
}

function shouldTryLocalFallback(error: unknown): boolean {
  if (error instanceof TypeError) {
    return true;
  }

  return error instanceof Error && /failed to fetch|networkerror|load failed/i.test(error.message);
}

async function requestFromBase<T>(baseUrl: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const baseUrl = getApiBaseUrl();

  try {
    return await requestFromBase<T>(baseUrl, path, init);
  } catch (error) {
    if (!isLocalDefaultMode(baseUrl) || !shouldTryLocalFallback(error)) {
      throw error;
    }

    const candidates = Array.from(new Set(LOCAL_API_CANDIDATES.map(normalizeBaseUrl))).filter((candidate) => candidate !== baseUrl);
    for (const candidate of candidates) {
      try {
        const result = await requestFromBase<T>(candidate, path, init);
        rememberDetectedApiBaseUrl(candidate);
        return result;
      } catch {
        // Try the next local agent candidate.
      }
    }

    throw error;
  }
}

export const api = {
  get baseUrl() {
    return getApiBaseUrl();
  },
  defaultBaseUrl: DEFAULT_API_BASE_URL,
  cloudBaseUrl: CLOUD_API_BASE_URL,
  setBaseUrl: setApiBaseUrl,
  resetBaseUrl: resetApiBaseUrl,
  isUsingCloudBackend,
  localCandidates: LOCAL_API_CANDIDATES,
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
  historyExportUrl: (format: "json" | "csv") => `${getApiBaseUrl()}/api/history/export?format=${format}`
};

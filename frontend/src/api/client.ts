import type { DiskInfo, SmartctlDetection } from "../types/disk";
import type {
  RecoveryHealthCheck,
  RecoveryHistoryRecord,
  RecoveryJobSnapshot,
  RecoveryLocation,
  RecoveryPathValidation,
  RecoveryStartRequest,
  RecoveryToolsDetection
} from "../types/recovery";
import type { RelocationJobSnapshot, RelocationPreview, RelocationRequest } from "../types/relocation";
import type { HistoryRecord, TransferJobSnapshot, TransferPreview, TransferRequest } from "../types/transfer";

export interface FirebaseClientConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  appId?: string;
  messagingSenderId?: string;
  storageBucket?: string;
}

export interface AuthConfig {
  authRequired: boolean;
  firebase: FirebaseClientConfig | null;
  emailAllowlistEnabled: boolean;
}

const LOCAL_API_DEFAULT_URL = "http://localhost:3335";
const CONFIGURED_API_BASE_URL = import.meta.env.VITE_API_BASE_URL?.trim();
const API_BASE_URL_STORAGE_KEY = "safe-disk-api-url";
const API_BASE_URL_USER_SET_KEY = "safe-disk-api-url-user-set";

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

const DEFAULT_API_BASE_URL = CONFIGURED_API_BASE_URL ? normalizeBaseUrl(CONFIGURED_API_BASE_URL) : LOCAL_API_DEFAULT_URL;
const LOCAL_API_CANDIDATES = [
  LOCAL_API_DEFAULT_URL,
  "http://localhost:3336",
  "http://localhost:3340",
  "http://127.0.0.1:3335",
  "http://127.0.0.1:3336",
  "http://127.0.0.1:3340",
  "http://localhost:3341",
  "http://127.0.0.1:3341"
];
let detectedApiBaseUrl: string | undefined;
let authTokenProvider: (() => Promise<string | undefined>) | undefined;

class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

export function setApiAuthTokenProvider(provider: (() => Promise<string | undefined>) | undefined): void {
  authTokenProvider = provider;
}

export function getApiBaseUrl(): string {
  if (typeof window === "undefined") {
    return DEFAULT_API_BASE_URL;
  }

  window.localStorage.removeItem(API_BASE_URL_STORAGE_KEY);
  window.localStorage.removeItem(API_BASE_URL_USER_SET_KEY);
  return detectedApiBaseUrl ?? DEFAULT_API_BASE_URL;
}

function rememberDetectedApiBaseUrl(value: string): void {
  detectedApiBaseUrl = normalizeBaseUrl(value);
}

function isLocalDefaultMode(baseUrl: string): boolean {
  return LOCAL_API_CANDIDATES.includes(baseUrl);
}

function shouldTryLocalFallback(error: unknown, path: string): boolean {
  if (error instanceof TypeError) {
    return true;
  }

  if (error instanceof ApiRequestError && error.status === 404 && path.startsWith("/api/recovery")) {
    return true;
  }

  return error instanceof Error && /failed to fetch|networkerror|load failed/i.test(error.message);
}

function isConnectionFailure(error: unknown): boolean {
  return (
    error instanceof TypeError ||
    (error instanceof Error && /failed to fetch|networkerror|load failed/i.test(error.message))
  );
}

function localBackendConnectionError(): Error {
  return new Error(
    "Nao consegui conectar ao backend local do SafeDisk. Inicie o backend com npm run dev:backend e mantenha esta janela aberta para carregar discos, historico e recuperacao."
  );
}

async function headersWithAuth(init?: RequestInit): Promise<Headers> {
  const headers = new Headers(init?.headers);
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const token = await authTokenProvider?.();
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  return headers;
}

async function responseErrorMessage(response: Response): Promise<string> {
  let message = `Erro HTTP ${response.status}`;
  try {
    const payload = (await response.json()) as { error?: string };
    return payload.error ?? message;
  } catch {
    const text = await response.text();
    return text || message;
  }
}

async function requestFromBase<T>(baseUrl: string, path: string, init?: RequestInit): Promise<T> {
  const { headers: _headers, ...rest } = init ?? {};
  const response = await fetch(`${baseUrl}${path}`, {
    ...rest,
    headers: await headersWithAuth(init)
  });

  if (!response.ok) {
    throw new ApiRequestError(await responseErrorMessage(response), response.status);
  }

  return (await response.json()) as T;
}

async function blobFromBase(baseUrl: string, path: string, init?: RequestInit): Promise<{ blob: Blob; filename?: string }> {
  const { headers: _headers, ...rest } = init ?? {};
  const response = await fetch(`${baseUrl}${path}`, {
    ...rest,
    headers: await headersWithAuth(init)
  });

  if (!response.ok) {
    throw new ApiRequestError(await responseErrorMessage(response), response.status);
  }

  return {
    blob: await response.blob(),
    filename: filenameFromDisposition(response.headers.get("content-disposition"))
  };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const baseUrl = getApiBaseUrl();

  try {
    return await requestFromBase<T>(baseUrl, path, init);
  } catch (error) {
    if (!isLocalDefaultMode(baseUrl) || !shouldTryLocalFallback(error, path)) {
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

    throw isConnectionFailure(error) ? localBackendConnectionError() : error;
  }
}

function filenameFromDisposition(value: string | null): string | undefined {
  if (!value) {
    return undefined;
  }

  const encoded = value.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded);
    } catch {
      return encoded;
    }
  }

  return value.match(/filename="?([^";]+)"?/i)?.[1];
}

function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

async function download(path: string, fallbackFilename: string): Promise<void> {
  const baseUrl = getApiBaseUrl();

  try {
    const result = await blobFromBase(baseUrl, path);
    saveBlob(result.blob, result.filename ?? fallbackFilename);
    return;
  } catch (error) {
    if (!isLocalDefaultMode(baseUrl) || !shouldTryLocalFallback(error, path)) {
      throw error;
    }

    const candidates = Array.from(new Set(LOCAL_API_CANDIDATES.map(normalizeBaseUrl))).filter((candidate) => candidate !== baseUrl);
    for (const candidate of candidates) {
      try {
        const result = await blobFromBase(candidate, path);
        rememberDetectedApiBaseUrl(candidate);
        saveBlob(result.blob, result.filename ?? fallbackFilename);
        return;
      } catch {
        // Try the next local agent candidate.
      }
    }

    throw isConnectionFailure(error) ? localBackendConnectionError() : error;
  }
}

export const api = {
  get baseUrl() {
    return getApiBaseUrl();
  },
  defaultBaseUrl: DEFAULT_API_BASE_URL,
  localCandidates: LOCAL_API_CANDIDATES,
  getAuthConfig: () => request<AuthConfig>("/api/auth/config"),
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
  getRecoveryLocations: () => request<RecoveryLocation[]>("/api/recovery/locations"),
  validateRecoveryPaths: (originPath: string, destinationPath: string) =>
    request<RecoveryPathValidation>("/api/recovery/validate-paths", {
      method: "POST",
      body: JSON.stringify({ originPath, destinationPath })
    }),
  checkRecoveryHealth: (originPath: string) =>
    request<RecoveryHealthCheck>(`/api/recovery/health-check?originPath=${encodeURIComponent(originPath)}`),
  detectRecoveryTools: () => request<RecoveryToolsDetection>("/api/recovery/tools"),
  startRecovery: (body: RecoveryStartRequest) =>
    request<RecoveryJobSnapshot>("/api/recovery/start", {
      method: "POST",
      body: JSON.stringify(body)
    }),
  getRecoveryStatus: (jobId: string) => request<RecoveryJobSnapshot>(`/api/recovery/status/${encodeURIComponent(jobId)}`),
  cancelRecovery: (jobId: string) =>
    request<RecoveryJobSnapshot>(`/api/recovery/cancel/${encodeURIComponent(jobId)}`, { method: "POST" }),
  getRecoveryHistory: () => request<RecoveryHistoryRecord[]>("/api/recovery/history"),
  recoveryReportUrl: (jobId: string, format: "txt" | "json") =>
    `${getApiBaseUrl()}/api/recovery/report/${encodeURIComponent(jobId)}?format=${format}`,
  downloadRecoveryReport: (jobId: string, format: "txt" | "json") =>
    download(`/api/recovery/report/${encodeURIComponent(jobId)}?format=${format}`, `recovery-report-${jobId}.${format}`),
  openRecoveredFolder: (path: string) =>
    request<{ ok: true }>("/api/recovery/open-folder", {
      method: "POST",
      body: JSON.stringify({ path })
    }),
  getHistory: () => request<HistoryRecord[]>("/api/history"),
  historyExportUrl: (format: "json" | "csv") => `${getApiBaseUrl()}/api/history/export?format=${format}`,
  downloadHistory: (format: "json" | "csv") => download(`/api/history/export?format=${format}`, `safe-disk-transfer-history.${format}`)
};

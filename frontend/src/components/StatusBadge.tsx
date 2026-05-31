import type { DiskHealthStatus } from "../types/disk";
import type { FileTransferStatus, JobStatus, PreviewAction } from "../types/transfer";

type BadgeStatus = DiskHealthStatus | FileTransferStatus | JobStatus | PreviewAction | "info";

const labels: Record<string, string> = {
  healthy: "Saudavel",
  warning: "Atencao",
  critical: "Critico",
  unknown: "Desconhecido",
  queued: "Na fila",
  running: "Rodando",
  paused: "Pausado",
  completed: "Concluido",
  failed: "Falhou",
  canceled: "Cancelado",
  simulation: "Simulacao",
  copying: "Copiando",
  verifying: "Verificando",
  finalizing: "Finalizando",
  success: "Sucesso",
  skipped: "Ignorado",
  error: "Erro",
  simulated: "Simulado",
  move: "Mover",
  rename: "Renomear",
  replace: "Substituir",
  skip: "Ignorar",
  conflict: "Conflito",
  unavailable: "Indisponivel",
  info: "Info"
};

export function StatusBadge({ status, label }: { status: BadgeStatus; label?: string }) {
  return <span className={`status-badge status-${status}`}>{label ?? labels[status] ?? status}</span>;
}

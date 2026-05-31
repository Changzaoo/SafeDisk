import { FileSearch, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api/client";
import { DiskCard } from "../components/DiskCard";
import { StatusBadge } from "../components/StatusBadge";
import type { PageId } from "../components/Sidebar";
import type { DiskInfo, DiskHealthStatus } from "../types/disk";
import { formatBytes } from "../utils/format";

export function Dashboard({
  notify,
  onNavigate
}: {
  notify: (message: string, tone?: "success" | "error" | "info") => void;
  onNavigate?: (page: PageId) => void;
}) {
  const [disks, setDisks] = useState<DiskInfo[]>([]);
  const [loading, setLoading] = useState(true);

  const loadDisks = useCallback(async () => {
    setLoading(true);
    try {
      setDisks(await api.getDisks());
    } catch (error) {
      notify(error instanceof Error ? error.message : "Falha ao carregar discos.", "error");
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => {
    void loadDisks();
  }, [loadDisks]);

  const counts = useMemo(() => {
    const seed: Record<DiskHealthStatus, number> = { healthy: 0, warning: 0, critical: 0, unknown: 0 };
    return disks.reduce((accumulator, disk) => {
      accumulator[disk.status] += 1;
      return accumulator;
    }, seed);
  }, [disks]);

  const totalCapacity = disks.reduce((sum, disk) => sum + disk.sizeBytes, 0);
  const totalFree = disks.reduce((sum, disk) => sum + (disk.freeBytes ?? 0), 0);

  return (
    <section className="page">
      <header className="page-header">
        <div>
          <h1>Dashboard</h1>
          <p>{loading ? "Consultando discos..." : `${disks.length} disco(s) detectado(s)`}</p>
        </div>
        <button className="icon-button label-button" type="button" onClick={loadDisks} disabled={loading}>
          <RefreshCw size={18} />
          Atualizar
        </button>
      </header>

      <div className="summary-grid">
        <div className="summary-tile">
          <span>Capacidade</span>
          <strong>{formatBytes(totalCapacity)}</strong>
        </div>
        <div className="summary-tile">
          <span>Espaco livre</span>
          <strong>{formatBytes(totalFree)}</strong>
        </div>
        <div className="summary-tile">
          <span>Status</span>
          <div className="status-row">
            <StatusBadge status="healthy" label={`${counts.healthy} ok`} />
            <StatusBadge status="warning" label={`${counts.warning} atencao`} />
            <StatusBadge status="critical" label={`${counts.critical} critico`} />
            <StatusBadge status="unknown" label={`${counts.unknown} desconhecido`} />
          </div>
        </div>
      </div>

      <div className="dashboard-actions">
        <button className="action-card dashboard-action-card" type="button" onClick={() => onNavigate?.("recovery")}>
          <FileSearch size={22} />
          <strong>Recuperar arquivos</strong>
          <small>Tente encontrar arquivos apagados ou perdidos sem salvar no mesmo disco.</small>
        </button>
      </div>

      <div className="disk-grid">
        {disks.map((disk) => (
          <DiskCard disk={disk} key={disk.id} />
        ))}
      </div>
    </section>
  );
}

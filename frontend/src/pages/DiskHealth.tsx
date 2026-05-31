import { Cloud, RefreshCw, ShieldAlert } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api } from "../api/client";
import { DiskCard } from "../components/DiskCard";
import { StatusBadge } from "../components/StatusBadge";
import type { DiskInfo, SmartctlDetection } from "../types/disk";
import { formatBytes } from "../utils/format";

export function DiskHealth({ notify }: { notify: (message: string, tone?: "success" | "error" | "info") => void }) {
  const [disks, setDisks] = useState<DiskInfo[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [smartctl, setSmartctl] = useState<SmartctlDetection>();
  const [loading, setLoading] = useState(true);

  const selected = disks.find((disk) => disk.id === selectedId) ?? disks[0];

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [diskList, smartctlStatus] = await Promise.all([api.getDisks(), api.getSmartctl()]);
      setDisks(diskList);
      setSelectedId((current) => current ?? diskList[0]?.id);
      setSmartctl(smartctlStatus);
    } catch (error) {
      notify(error instanceof Error ? error.message : "Falha ao consultar saude.", "error");
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className="page">
      <header className="page-header">
        <div>
          <h1>Saude dos discos</h1>
          <p>{loading ? "Carregando indicadores..." : "SMART, volumes e status do Windows"}</p>
        </div>
        <button className="icon-button label-button" type="button" onClick={load} disabled={loading}>
          <RefreshCw size={18} />
          Atualizar
        </button>
      </header>

      {api.isUsingCloudBackend() ? (
        <div className="notice notice-warning">
          <Cloud size={18} />
          <span>
            O backend hospedado no Render nao acessa SMART, PowerShell, WMIC nem arquivos do seu Windows. Para ver saude real dos discos, use o backend local.
          </span>
        </div>
      ) : null}

      <div className={`notice ${smartctl?.installed ? "notice-success" : "notice-warning"}`}>
        <ShieldAlert size={18} />
        <span>
          {smartctl?.installed
            ? `smartctl detectado: ${smartctl.version ?? "versao disponivel"}`
            : smartctl?.installHint ?? "smartctl nao detectado."}
        </span>
      </div>

      <div className="split-layout">
        <div className="disk-list">
          {disks.map((disk) => (
            <DiskCard disk={disk} active={selected?.id === disk.id} key={disk.id} onSelect={(item) => setSelectedId(item.id)} />
          ))}
        </div>

        {selected ? (
          <div className="detail-panel">
            <div className="detail-heading">
              <div>
                <h2>{selected.model}</h2>
                <span>{selected.serialNumber ?? "Sem serial informado"}</span>
              </div>
              <StatusBadge status={selected.status} label={selected.statusLabel} />
            </div>

            <div className="detail-grid">
              <span>
                <strong>{selected.type}</strong>
                Tipo
              </span>
              <span>
                <strong>{formatBytes(selected.sizeBytes)}</strong>
                Capacidade
              </span>
              <span>
                <strong>{selected.temperatureC != null ? `${selected.temperatureC} C` : "-"}</strong>
                Temperatura
              </span>
              <span>
                <strong>{selected.powerOnHours?.toLocaleString("pt-BR") ?? "-"}</strong>
                Horas de uso
              </span>
              <span>
                <strong>{selected.reallocatedSectors ?? "-"}</strong>
                Setores realocados
              </span>
              <span>
                <strong>{selected.smartErrors ?? "-"}</strong>
                Erros SMART
              </span>
              <span>
                <strong>{selected.wearLevelPercent != null ? `${selected.wearLevelPercent}%` : "-"}</strong>
                Desgaste SSD
              </span>
              <span>
                <strong>{selected.smartAvailable ? "Disponivel" : "Basico"}</strong>
                SMART
              </span>
            </div>

            {selected.healthMessage ? <p className="detail-message">{selected.healthMessage}</p> : null}

            <h3>Volumes</h3>
            <div className="table-wrap compact">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Unidade</th>
                    <th>Rotulo</th>
                    <th>Sistema</th>
                    <th>Total</th>
                    <th>Livre</th>
                  </tr>
                </thead>
                <tbody>
                  {selected.volumes.length === 0 ? (
                    <tr>
                      <td colSpan={5}>Nenhum volume associado.</td>
                    </tr>
                  ) : (
                    selected.volumes.map((volume) => (
                      <tr key={volume.driveLetter ?? volume.path}>
                        <td>{volume.driveLetter ? `${volume.driveLetter}:` : "-"}</td>
                        <td>{volume.label ?? "-"}</td>
                        <td>{volume.fileSystem ?? "-"}</td>
                        <td>{formatBytes(volume.sizeBytes)}</td>
                        <td>{formatBytes(volume.freeBytes)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            <h3>Atributos SMART</h3>
            <div className="table-wrap compact">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>Atributo</th>
                    <th>Valor</th>
                    <th>Pior</th>
                    <th>Limite</th>
                    <th>Raw</th>
                  </tr>
                </thead>
                <tbody>
                  {selected.smartAttributes.length === 0 ? (
                    <tr>
                      <td colSpan={6}>Sem atributos SMART avancados.</td>
                    </tr>
                  ) : (
                    selected.smartAttributes.map((attribute) => (
                      <tr key={`${attribute.id}-${attribute.name}`}>
                        <td>{attribute.id ?? "-"}</td>
                        <td>{attribute.name}</td>
                        <td>{attribute.value ?? "-"}</td>
                        <td>{attribute.worst ?? "-"}</td>
                        <td>{attribute.threshold ?? "-"}</td>
                        <td>{attribute.raw ?? "-"}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}

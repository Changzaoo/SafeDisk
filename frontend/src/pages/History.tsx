import { Download, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api } from "../api/client";
import { StatusBadge } from "../components/StatusBadge";
import type { HistoryRecord } from "../types/transfer";
import { formatBytes, formatDate, shortHash } from "../utils/format";

export function History({ notify }: { notify: (message: string, tone?: "success" | "error" | "info") => void }) {
  const [records, setRecords] = useState<HistoryRecord[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRecords(await api.getHistory());
    } catch (error) {
      notify(error instanceof Error ? error.message : "Falha ao carregar historico.", "error");
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => {
    void load();
  }, [load]);

  const exportHistory = useCallback(
    async (format: "json" | "csv") => {
      try {
        await api.downloadHistory(format);
      } catch (error) {
        notify(error instanceof Error ? error.message : "Falha ao exportar historico.", "error");
      }
    },
    [notify]
  );

  return (
    <section className="page">
      <header className="page-header">
        <div>
          <h1>Historico</h1>
          <p>{loading ? "Carregando..." : `${records.length} registro(s)`}</p>
        </div>
        <div className="button-row">
          <button className="icon-button label-button" type="button" onClick={load} disabled={loading}>
            <RefreshCw size={18} />
            Atualizar
          </button>
          <button className="icon-button label-button" type="button" onClick={() => void exportHistory("json")}>
            <Download size={18} />
            JSON
          </button>
          <button className="icon-button label-button" type="button" onClick={() => void exportHistory("csv")}>
            <Download size={18} />
            CSV
          </button>
        </div>
      </header>

      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Data</th>
              <th>Origem</th>
              <th>Destino</th>
              <th>Tamanho</th>
              <th>Status</th>
              <th>Hash origem</th>
              <th>Hash destino</th>
            </tr>
          </thead>
          <tbody>
            {records.length === 0 ? (
              <tr>
                <td colSpan={7}>Nenhum historico gravado.</td>
              </tr>
            ) : (
              records.map((record) => (
                <tr key={record.id}>
                  <td>{formatDate(record.timestamp)}</td>
                  <td title={record.sourcePath}>{record.sourcePath}</td>
                  <td title={record.destinationPath}>{record.destinationPath}</td>
                  <td>{formatBytes(record.sizeBytes)}</td>
                  <td>
                    <StatusBadge status={record.status === "success" ? "success" : record.status === "canceled" ? "canceled" : "error"} />
                    {record.errorMessage ? <span className="row-message">{record.errorMessage}</span> : null}
                  </td>
                  <td>{shortHash(record.hashSource)}</td>
                  <td>{shortHash(record.hashDestination)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

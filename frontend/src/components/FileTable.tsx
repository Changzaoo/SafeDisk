import type { PreviewFile, TransferFileProgress } from "../types/transfer";
import { formatBytes, percent, shortHash } from "../utils/format";
import { ProgressBar } from "./ProgressBar";
import { StatusBadge } from "./StatusBadge";

function isProgressFile(file: PreviewFile | TransferFileProgress): file is TransferFileProgress {
  return "transferredBytes" in file;
}

export function FileTable({ files }: { files: Array<PreviewFile | TransferFileProgress> }) {
  if (files.length === 0) {
    return <div className="empty-state">Nenhum arquivo listado.</div>;
  }

  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            <th>Origem</th>
            <th>Destino</th>
            <th>Tamanho</th>
            <th>Status</th>
            <th>Progresso</th>
            <th>Hash</th>
          </tr>
        </thead>
        <tbody>
          {files.map((file, index) => {
            const progress = isProgressFile(file) ? percent(file.transferredBytes, file.sizeBytes) : 0;
            return (
              <tr key={`${file.source}-${index}`}>
                <td title={file.source}>{file.source}</td>
                <td title={file.destination}>{file.destination ?? "-"}</td>
                <td>{formatBytes(file.sizeBytes)}</td>
                <td>
                  <StatusBadge status={isProgressFile(file) ? file.status : file.action} />
                  {file.message ? <span className="row-message">{file.message}</span> : null}
                </td>
                <td>
                  {isProgressFile(file) ? <ProgressBar value={progress} label={`${Math.round(progress)}%`} /> : "-"}
                </td>
                <td>{isProgressFile(file) ? shortHash(file.hashDestination ?? file.hashSource) : file.hashMatch == null ? "-" : file.hashMatch ? "iguais" : "diferentes"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

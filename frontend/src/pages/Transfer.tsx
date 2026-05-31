import { AlertTriangle, Ban, Check, FileCheck2, Pause, Play, RotateCcw, Send, Square, X } from "lucide-react";
import { DragEvent, useEffect, useMemo, useState } from "react";
import { api } from "../api/client";
import { FileTable } from "../components/FileTable";
import { ProgressBar } from "../components/ProgressBar";
import { StatusBadge } from "../components/StatusBadge";
import type { LinkType, RelocationJobSnapshot, RelocationPreview, RelocationRequest } from "../types/relocation";
import type { ConflictMode, TransferJobSnapshot, TransferPreview, TransferRequest } from "../types/transfer";
import { formatBytes, percent } from "../utils/format";
import type { TransferDefaults } from "../App";

function parseSources(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

type TransferMode = "files" | "relocation";

interface PendingConfirmation {
  mode: TransferMode;
  title: string;
  message: string;
}

export function Transfer({
  defaults,
  notify
}: {
  defaults: TransferDefaults;
  notify: (message: string, tone?: "success" | "error" | "info") => void;
}) {
  const [mode, setMode] = useState<TransferMode>("files");
  const [sourcesText, setSourcesText] = useState("");
  const [destination, setDestination] = useState("");
  const [conflictMode, setConflictMode] = useState<ConflictMode>("rename");
  const [simulation, setSimulation] = useState(defaults.simulationDefault);
  const [preview, setPreview] = useState<TransferPreview>();
  const [job, setJob] = useState<TransferJobSnapshot>();
  const [relocationSource, setRelocationSource] = useState("");
  const [relocationDestinationParent, setRelocationDestinationParent] = useState("");
  const [relocationDestinationName, setRelocationDestinationName] = useState("");
  const [relocationLinkType, setRelocationLinkType] = useState<LinkType>("junction");
  const [relocationKeepBackup, setRelocationKeepBackup] = useState(true);
  const [relocationPreview, setRelocationPreview] = useState<RelocationPreview>();
  const [relocationJob, setRelocationJob] = useState<RelocationJobSnapshot>();
  const [pendingConfirmation, setPendingConfirmation] = useState<PendingConfirmation>();
  const [busy, setBusy] = useState(false);

  const sources = useMemo(() => parseSources(sourcesText), [sourcesText]);
  const requestBody: TransferRequest = {
    sources,
    destination,
    conflictMode,
    simulation,
    safetyMarginPercent: defaults.minFreeMarginPercent,
    safetyMarginBytes: defaults.minFreeMarginGb * 1024 * 1024 * 1024
  };
  const relocationBody: RelocationRequest = {
    source: relocationSource,
    destinationParent: relocationDestinationParent,
    destinationName: relocationDestinationName,
    linkType: relocationLinkType,
    simulation,
    keepBackup: relocationKeepBackup,
    safetyMarginPercent: defaults.minFreeMarginPercent,
    safetyMarginBytes: defaults.minFreeMarginGb * 1024 * 1024 * 1024
  };

  useEffect(() => {
    if (!job?.jobId || ["completed", "failed", "canceled", "simulation"].includes(job.status)) {
      return;
    }

    const timer = window.setInterval(async () => {
      try {
        setJob(await api.getTransferStatus(job.jobId));
      } catch (error) {
        notify(error instanceof Error ? error.message : "Falha ao atualizar job.", "error");
      }
    }, 900);

    return () => window.clearInterval(timer);
  }, [job?.jobId, job?.status, notify]);

  useEffect(() => {
    if (!relocationJob?.jobId || ["completed", "failed", "canceled", "simulation"].includes(relocationJob.status)) {
      return;
    }

    const timer = window.setInterval(async () => {
      try {
        setRelocationJob(await api.getRelocationStatus(relocationJob.jobId));
      } catch (error) {
        notify(error instanceof Error ? error.message : "Falha ao atualizar relocacao.", "error");
      }
    }, 900);

    return () => window.clearInterval(timer);
  }, [relocationJob?.jobId, relocationJob?.status, notify]);

  async function handlePreview() {
    setBusy(true);
    try {
      if (mode === "relocation") {
        const result = await api.previewRelocation(relocationBody);
        setRelocationPreview(result);
        setRelocationJob(undefined);
      } else {
        const result = await api.previewTransfer(requestBody);
        setPreview(result);
        setJob(undefined);
      }
      notify("Pre-visualizacao criada.", "success");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Falha na pre-visualizacao.", "error");
    } finally {
      setBusy(false);
    }
  }

  async function startCurrentMode(startMode: TransferMode) {
    setBusy(true);
    try {
      if (startMode === "relocation") {
        const result = await api.startRelocation(relocationBody);
        setRelocationJob(result);
        notify(simulation ? "Simulacao executada." : "Relocacao iniciada.", "success");
      } else {
        const result = await api.startTransfer(requestBody);
        setJob(result);
        notify(simulation ? "Simulacao executada." : "Transferencia iniciada.", "success");
      }
    } catch (error) {
      notify(error instanceof Error ? error.message : "Falha ao iniciar transferencia.", "error");
    } finally {
      setBusy(false);
    }
  }

  function handleStart() {
    if (simulation) {
      void startCurrentMode(mode);
      return;
    }

    setPendingConfirmation(
      mode === "relocation"
        ? {
            mode,
            title: "Confirmar relocacao real?",
            message: "A pasta sera copiada, validada, movida para backup e o caminho antigo virara uma junction/symlink."
          }
        : {
            mode,
            title: "Confirmar transferencia real?",
            message: "Os originais so serao apagados depois do hash validar a copia."
          }
    );
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    const paths = Array.from(event.dataTransfer.files)
      .map((file) => (file as File & { path?: string }).path)
      .filter((value): value is string => Boolean(value));

    if (paths.length === 0) {
      notify("O navegador nao expos caminhos reais. Digite os caminhos completos.", "info");
      return;
    }

    setSourcesText((current) => [current, ...paths].filter(Boolean).join("\n"));
  }

  const totalProgress = job ? percent(job.transferredBytes, job.totalBytes) : 0;
  const relocationProgress = relocationJob ? percent(relocationJob.copiedBytes, relocationJob.totalBytes) : 0;
  const canPreviewFiles = sources.length > 0 && Boolean(destination);
  const canPreviewRelocation = Boolean(relocationSource && relocationDestinationParent);

  return (
    <section className="page">
      <header className="page-header">
        <div>
          <h1>Transferencia segura</h1>
          <p>{mode === "files" ? `${sources.length} origem(ns) selecionada(s)` : "Relocar pasta e manter o caminho antigo funcionando"}</p>
        </div>
        <div className="button-row">
          <button
            className="icon-button label-button"
            type="button"
            onClick={handlePreview}
            disabled={busy || (mode === "files" ? !canPreviewFiles : !canPreviewRelocation)}
          >
            <FileCheck2 size={18} />
            Previa
          </button>
          <button
            className="icon-button label-button primary"
            type="button"
            onClick={handleStart}
            disabled={busy || (mode === "files" ? !canPreviewFiles : !canPreviewRelocation)}
          >
            <Send size={18} />
            Iniciar
          </button>
        </div>
      </header>

      <div className="segmented mode-switch" role="group" aria-label="Modo de transferencia">
        <button className={mode === "files" ? "is-active" : ""} type="button" onClick={() => setMode("files")}>
          Arquivos
        </button>
        <button className={mode === "relocation" ? "is-active" : ""} type="button" onClick={() => setMode("relocation")}>
          Relocar pasta
        </button>
      </div>

      {mode === "files" ? (
        <div className="transfer-form">
          <div className="form-panel">
            <label>
              Origens
              <textarea
                value={sourcesText}
                onChange={(event) => setSourcesText(event.target.value)}
                placeholder="C:\\Origem\\arquivo.mp4&#10;C:\\Origem\\Pasta"
                rows={7}
              />
            </label>

            <div className="drop-zone" onDragOver={(event) => event.preventDefault()} onDrop={handleDrop}>
              Arraste arquivos ou pastas
            </div>
          </div>

          <div className="form-panel">
            <label>
              Destino
              <input value={destination} onChange={(event) => setDestination(event.target.value)} placeholder="D:\\Backup" />
            </label>

            <div className="segmented" role="group" aria-label="Modo de conflito">
              {(["rename", "replace", "skip", "compare"] as ConflictMode[]).map((conflictOption) => (
                <button
                  className={conflictMode === conflictOption ? "is-active" : ""}
                  key={conflictOption}
                  type="button"
                  onClick={() => setConflictMode(conflictOption)}
                >
                  {conflictOption === "rename" ? "Renomear" : conflictOption === "replace" ? "Substituir" : conflictOption === "skip" ? "Ignorar" : "Comparar"}
                </button>
              ))}
            </div>

            <label className="toggle-line">
              <input checked={simulation} type="checkbox" onChange={(event) => setSimulation(event.target.checked)} />
              Modo simulacao
            </label>
          </div>
        </div>
      ) : (
        <div className="transfer-form">
          <div className="form-panel">
            <label>
              Pasta original
              <input value={relocationSource} onChange={(event) => setRelocationSource(event.target.value)} placeholder="C:\\Projetos\\MeuProjeto" />
            </label>
            <label>
              Pasta de destino
              <input value={relocationDestinationParent} onChange={(event) => setRelocationDestinationParent(event.target.value)} placeholder="D:\\Projetos" />
            </label>
            <label>
              Nome no destino
              <input value={relocationDestinationName} onChange={(event) => setRelocationDestinationName(event.target.value)} placeholder="MeuProjeto" />
            </label>
          </div>

          <div className="form-panel">
            <div className="segmented" role="group" aria-label="Tipo de link">
              {(["junction", "symlink"] as LinkType[]).map((linkOption) => (
                <button
                  className={relocationLinkType === linkOption ? "is-active" : ""}
                  key={linkOption}
                  type="button"
                  onClick={() => setRelocationLinkType(linkOption)}
                >
                  {linkOption === "junction" ? "Junction" : "Symlink"}
                </button>
              ))}
            </div>
            <label className="toggle-line">
              <input checked={simulation} type="checkbox" onChange={(event) => setSimulation(event.target.checked)} />
              Modo simulacao
            </label>
            <label className="toggle-line">
              <input checked={relocationKeepBackup} type="checkbox" onChange={(event) => setRelocationKeepBackup(event.target.checked)} />
              Manter backup da pasta original
            </label>
            <div className="notice notice-warning inline-notice">
              <Ban size={18} />
              <span>Feche editores, servidores e programas que estejam usando essa pasta antes da relocacao real.</span>
            </div>
          </div>
        </div>
      )}

      {mode === "files" && preview ? (
        <div className="preview-panel">
          <div className="summary-grid">
            <div className="summary-tile">
              <span>Arquivos</span>
              <strong>{preview.fileCount}</strong>
            </div>
            <div className="summary-tile">
              <span>Total</span>
              <strong>{formatBytes(preview.totalBytes)}</strong>
            </div>
            <div className="summary-tile">
              <span>Livre depois</span>
              <strong>{formatBytes(preview.destinationFreeAfterBytes)}</strong>
            </div>
            <div className="summary-tile">
              <span>Espaco</span>
              <StatusBadge status={preview.hasEnoughSpace ? "healthy" : "critical"} label={preview.hasEnoughSpace ? "Suficiente" : "Insuficiente"} />
            </div>
          </div>

          {preview.warnings.length > 0 ? (
            <div className="notice notice-warning">
              <Ban size={18} />
              <span>{preview.warnings.join(" ")}</span>
            </div>
          ) : null}

          <FileTable files={preview.files} />
        </div>
      ) : null}

      {mode === "relocation" && relocationPreview ? (
        <div className="preview-panel">
          <div className="summary-grid">
            <div className="summary-tile">
              <span>Arquivos</span>
              <strong>{relocationPreview.fileCount}</strong>
            </div>
            <div className="summary-tile">
              <span>Total</span>
              <strong>{formatBytes(relocationPreview.totalBytes)}</strong>
            </div>
            <div className="summary-tile">
              <span>Livre depois</span>
              <strong>{formatBytes(relocationPreview.destinationFreeAfterBytes)}</strong>
            </div>
            <div className="summary-tile">
              <span>Espaco</span>
              <StatusBadge status={relocationPreview.hasEnoughSpace ? "healthy" : "critical"} label={relocationPreview.hasEnoughSpace ? "Suficiente" : "Insuficiente"} />
            </div>
          </div>

          <div className="path-summary">
            <span>
              <strong>Original</strong>
              {relocationPreview.linkPath}
            </span>
            <span>
              <strong>Novo local</strong>
              {relocationPreview.destinationPath}
            </span>
            <span>
              <strong>Backup</strong>
              {relocationPreview.backupPath}
            </span>
            <span>
              <strong>Link</strong>
              {relocationPreview.linkType}
            </span>
          </div>

          {relocationPreview.warnings.length > 0 ? (
            <div className="notice notice-warning">
              <Ban size={18} />
              <span>{relocationPreview.warnings.join(" ")}</span>
            </div>
          ) : null}
        </div>
      ) : null}

      {mode === "files" && job ? (
        <div className="job-panel">
          <div className="job-head">
            <div>
              <h2>Job {job.jobId.slice(0, 8)}</h2>
              <StatusBadge status={job.status} />
            </div>
            <div className="button-row">
              {job.status === "running" ? (
                <button className="icon-button" title="Pausar" type="button" onClick={async () => setJob(await api.pauseTransfer(job.jobId))}>
                  <Pause size={18} />
                </button>
              ) : null}
              {job.status === "paused" ? (
                <button className="icon-button" title="Retomar" type="button" onClick={async () => setJob(await api.resumeTransfer(job.jobId))}>
                  <Play size={18} />
                </button>
              ) : null}
              {["running", "paused", "queued"].includes(job.status) ? (
                <button className="icon-button danger" title="Cancelar" type="button" onClick={async () => setJob(await api.cancelTransfer(job.jobId))}>
                  <Square size={18} />
                </button>
              ) : (
                <button className="icon-button" title="Atualizar" type="button" onClick={async () => setJob(await api.getTransferStatus(job.jobId))}>
                  <RotateCcw size={18} />
                </button>
              )}
            </div>
          </div>
          <ProgressBar value={totalProgress} label={`${Math.round(totalProgress)}% total`} />
          <FileTable files={job.files} />
        </div>
      ) : null}

      {mode === "relocation" && relocationJob ? (
        <div className="job-panel">
          <div className="job-head">
            <div>
              <h2>Relocacao {relocationJob.jobId.slice(0, 8)}</h2>
              <StatusBadge status={relocationJob.status} />
            </div>
            <div className="button-row">
              {["running", "queued"].includes(relocationJob.status) ? (
                <button className="icon-button danger" title="Cancelar" type="button" onClick={async () => setRelocationJob(await api.cancelRelocation(relocationJob.jobId))}>
                  <Square size={18} />
                </button>
              ) : (
                <button className="icon-button" title="Atualizar" type="button" onClick={async () => setRelocationJob(await api.getRelocationStatus(relocationJob.jobId))}>
                  <RotateCcw size={18} />
                </button>
              )}
            </div>
          </div>
          <ProgressBar value={relocationProgress} label={`${Math.round(relocationProgress)}% copiado`} />
          <div className="path-summary">
            <span>
              <strong>Etapa</strong>
              {relocationJob.stage}
            </span>
            <span>
              <strong>Arquivos</strong>
              {relocationJob.processedFiles} / {relocationJob.fileCount}
            </span>
            <span>
              <strong>Caminho antigo</strong>
              {relocationJob.linkPath}
            </span>
            <span>
              <strong>Novo local</strong>
              {relocationJob.destinationPath}
            </span>
          </div>
          {relocationJob.currentFile ? <p className="detail-message">Atual: {relocationJob.currentFile}</p> : null}
          {relocationJob.errors.length > 0 ? (
            <div className="notice notice-warning">
              <Ban size={18} />
              <span>{relocationJob.errors.join(" ")}</span>
            </div>
          ) : null}
        </div>
      ) : null}

      {pendingConfirmation ? (
        <div className="modal-backdrop" role="presentation">
          <div className="app-modal" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
            <div className="modal-icon">
              <AlertTriangle size={24} />
            </div>
            <div>
              <h2 id="confirm-title">{pendingConfirmation.title}</h2>
              <p>{pendingConfirmation.message}</p>
            </div>
            <div className="modal-actions">
              <button className="icon-button label-button" type="button" onClick={() => setPendingConfirmation(undefined)}>
                <X size={18} />
                Cancelar
              </button>
              <button
                autoFocus
                className="icon-button label-button primary"
                type="button"
                onClick={() => {
                  const confirmedMode = pendingConfirmation.mode;
                  setPendingConfirmation(undefined);
                  void startCurrentMode(confirmedMode);
                }}
              >
                <Check size={18} />
                Confirmar
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

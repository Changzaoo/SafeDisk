import {
  AlertTriangle,
  Archive,
  CheckCircle2,
  ClipboardList,
  Download,
  FileHeart,
  FileSearch,
  FolderOpen,
  HardDrive,
  HelpCircle,
  History,
  Image,
  Info,
  Play,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  ShieldCheck,
  Square,
  Stethoscope,
  Usb,
  Wand2
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { api } from "../api/client";
import { ProgressBar } from "../components/ProgressBar";
import { StatusBadge } from "../components/StatusBadge";
import type {
  RecoveryCategory,
  RecoveryHealthCheck,
  RecoveryHistoryRecord,
  RecoveryJobSnapshot,
  RecoveryLocation,
  RecoveryMode,
  RecoveryPathValidation,
  RecoveryProblem,
  RecoveryToolInfo,
  RecoveryToolsDetection
} from "../types/recovery";
import { formatBytes, formatDate } from "../utils/format";

type Notify = (message: string, tone?: "success" | "error" | "info") => void;
type RecoveryView = "home" | "wizard" | "progress" | "results" | "history" | "help";

const problemCards: Array<{
  id: RecoveryProblem;
  title: string;
  suggestedMode: RecoveryMode;
  suggestion: string;
  icon: typeof FileSearch;
}> = [
  { id: "deleted-files", title: "Apaguei arquivos sem querer", suggestedMode: "quick", suggestion: "Busca rapida", icon: FileSearch },
  { id: "emptied-trash", title: "Esvaziei a lixeira", suggestedMode: "quick", suggestion: "Busca rapida com opcao profunda", icon: Archive },
  { id: "formatted-device", title: "Formatei um pendrive, cartao ou HD", suggestedMode: "deep", suggestion: "Busca profunda", icon: Usb },
  { id: "asks-format", title: "O dispositivo pede para formatar", suggestedMode: "deep", suggestion: "Busca profunda sem corrigir o dispositivo", icon: AlertTriangle },
  { id: "device-not-open", title: "O disco ou pendrive nao abre", suggestedMode: "safe-copy", suggestion: "Criar copia segura primeiro", icon: ShieldCheck },
  { id: "missing-files", title: "Os arquivos sumiram", suggestedMode: "quick", suggestion: "Busca rapida e depois profunda", icon: Search },
  { id: "slow-device", title: "O disco esta lento ou travando", suggestedMode: "health", suggestion: "Verificar saude e criar copia segura", icon: Stethoscope },
  { id: "disk-image", title: "Quero analisar uma copia de disco", suggestedMode: "image", suggestion: "Analisar arquivo de imagem", icon: FileHeart }
];

const modeCards: Array<{ id: RecoveryMode; title: string; text: string; icon: typeof Search }> = [
  { id: "quick", title: "Busca rapida", text: "Mais rapida. Boa para arquivos apagados recentemente.", icon: Search },
  { id: "deep", title: "Busca profunda", text: "Demora mais. Boa para pendrives formatados, cartoes com erro ou arquivos antigos.", icon: FileSearch },
  { id: "health", title: "Verificar saude primeiro", text: "Recomendado se o disco esta lento, travando ou fazendo barulho.", icon: Stethoscope },
  { id: "safe-copy", title: "Criar copia segura", text: "Recomendado antes de tentar recuperar de discos com problema.", icon: ShieldCheck },
  { id: "image", title: "Analisar arquivo de imagem", text: "Use quando voce ja tem uma copia em .img, .dd, .iso ou arquivo parecido.", icon: FileHeart }
];

const categoryLabels: Record<RecoveryCategory | "all", string> = {
  all: "Todos",
  images: "Imagens",
  documents: "Documentos",
  videos: "Videos",
  audios: "Audios",
  archives: "Compactados",
  others: "Outros"
};

const extensionChoices = ["jpg", "png", "pdf", "docx", "xlsx", "pptx", "mp4", "mp3", "zip", "txt"];

function problemLabel(problem: RecoveryProblem): string {
  return problemCards.find((item) => item.id === problem)?.title ?? problem;
}

function modeLabel(mode: RecoveryMode): string {
  return modeCards.find((item) => item.id === mode)?.title ?? (mode === "demo" ? "Modo demonstracao" : mode);
}

function isJobActive(job?: RecoveryJobSnapshot): boolean {
  return Boolean(job && (job.status === "queued" || job.status === "running" || (job.status === "simulation" && job.progress < 100)));
}

function statusText(job: RecoveryJobSnapshot): string {
  if (job.status === "canceled") {
    return "Interrompido com seguranca";
  }
  if (job.status === "failed") {
    return "Nao foi possivel concluir";
  }
  if (job.status === "simulation") {
    return "Demonstracao";
  }
  return job.phase;
}

function RecoveryWarningBox({ children, tone = "warning" }: { children: ReactNode; tone?: "warning" | "success" | "info" }) {
  return (
    <div className={`notice notice-${tone === "success" ? "success" : tone === "info" ? "info" : "warning"} recovery-warning`}>
      {tone === "success" ? <CheckCircle2 size={18} /> : tone === "info" ? <Info size={18} /> : <AlertTriangle size={18} />}
      <span>{children}</span>
    </div>
  );
}

function RecoveryModeCard({
  active,
  icon: Icon,
  title,
  text,
  onClick
}: {
  active: boolean;
  icon: typeof Search;
  title: string;
  text: string;
  onClick: () => void;
}) {
  return (
    <button className={`recovery-choice ${active ? "is-active" : ""}`} type="button" onClick={onClick}>
      <span className="choice-icon">
        <Icon size={20} />
      </span>
      <strong>{title}</strong>
      <small>{text}</small>
    </button>
  );
}

function RecoveryAdvancedDetails({ job, health, tools }: { job?: RecoveryJobSnapshot; health?: RecoveryHealthCheck; tools?: RecoveryToolsDetection }) {
  const content = {
    job,
    health,
    tools
  };

  return (
    <details className="advanced-details">
      <summary>Detalhes avancados</summary>
      <pre>{JSON.stringify(content, null, 2)}</pre>
    </details>
  );
}

function RecoveryDrivePicker({
  locations,
  selectedPath,
  onSelect
}: {
  locations: RecoveryLocation[];
  selectedPath: string;
  onSelect: (path: string) => void;
}) {
  return (
    <div className="location-grid">
      {locations.map((location) => {
        const Icon = location.kind === "removable" ? Usb : location.kind === "backup" ? Save : HardDrive;
        return (
          <button
            className={`location-card ${selectedPath === location.path ? "is-active" : ""}`}
            key={location.id}
            type="button"
            onClick={() => onSelect(location.path)}
          >
            <Icon size={19} />
            <span>
              <strong>{location.label}</strong>
              <small>{location.path}</small>
              {location.sizeBytes ? <small>{formatBytes(location.freeBytes)} livres de {formatBytes(location.sizeBytes)}</small> : null}
              {location.warning ? <small className="warning-text">{location.warning}</small> : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function RecoveryStepProblem({
  problem,
  onSelect
}: {
  problem: RecoveryProblem;
  onSelect: (problem: RecoveryProblem, mode: RecoveryMode) => void;
}) {
  return (
    <div className="wizard-step">
      <h2>O que aconteceu?</h2>
      <div className="choice-grid">
        {problemCards.map((item) => (
          <RecoveryModeCard
            active={problem === item.id}
            icon={item.icon}
            key={item.id}
            title={item.title}
            text={item.suggestion}
            onClick={() => onSelect(item.id, item.suggestedMode)}
          />
        ))}
      </div>
    </div>
  );
}

function RecoveryStepOrigin({
  locations,
  originPath,
  onChange,
  includeCommonFolders,
  onIncludeCommonFoldersChange
}: {
  locations: RecoveryLocation[];
  originPath: string;
  onChange: (path: string) => void;
  includeCommonFolders: boolean;
  onIncludeCommonFoldersChange: (checked: boolean) => void;
}) {
  return (
    <div className="wizard-step">
      <h2>Onde os arquivos estavam?</h2>
      <RecoveryWarningBox tone="info">
        Este recurso precisa de acesso local ao computador. No navegador puro, so conseguimos analisar arquivos, pastas ou caminhos que o aplicativo local consiga abrir.
      </RecoveryWarningBox>
      <div className="form-panel recovery-form-panel">
        <label>
          Caminho da pasta, unidade ou arquivo de imagem
          <input value={originPath} onChange={(event) => onChange(event.target.value)} placeholder="E:\\Fotos ou D:\\copia.img" />
        </label>
        <label className="toggle-line">
          <input checked={includeCommonFolders} type="checkbox" onChange={(event) => onIncludeCommonFoldersChange(event.target.checked)} />
          Procurar tambem em Downloads, Documentos, Area de Trabalho, Imagens e Videos
        </label>
      </div>
      <RecoveryDrivePicker locations={locations} selectedPath={originPath} onSelect={onChange} />
    </div>
  );
}

function RecoveryStepDestination({
  destinationPath,
  validation,
  onChange,
  onValidate
}: {
  destinationPath: string;
  validation?: RecoveryPathValidation;
  onChange: (path: string) => void;
  onValidate: () => void;
}) {
  return (
    <div className="wizard-step">
      <h2>Onde salvar os arquivos encontrados?</h2>
      <RecoveryWarningBox>
        Para proteger seus arquivos, escolha outro disco ou outra unidade. Salvar no mesmo lugar pode apagar de vez o que ainda pode ser recuperado.
      </RecoveryWarningBox>
      <div className="form-panel recovery-form-panel">
        <label>
          Pasta de destino
          <input value={destinationPath} onChange={(event) => onChange(event.target.value)} placeholder="F:\\Arquivos recuperados" />
        </label>
        <button className="icon-button label-button" type="button" onClick={onValidate}>
          <ShieldCheck size={18} />
          Validar
        </button>
      </div>
      {validation ? (
        <div className="validation-list">
          {validation.errors.map((error) => (
            <RecoveryWarningBox key={error}>{error}</RecoveryWarningBox>
          ))}
          {validation.warnings.map((warning) => (
            <RecoveryWarningBox key={warning}>{warning}</RecoveryWarningBox>
          ))}
          {validation.valid ? <RecoveryWarningBox tone="success">Destino protegido para esta busca.</RecoveryWarningBox> : null}
        </div>
      ) : null}
    </div>
  );
}

function RecoveryStepMode({
  mode,
  extensions,
  demo,
  onModeChange,
  onExtensionToggle,
  onDemoChange,
  onCheckHealth,
  health
}: {
  mode: RecoveryMode;
  extensions: string[];
  demo: boolean;
  onModeChange: (mode: RecoveryMode) => void;
  onExtensionToggle: (extension: string) => void;
  onDemoChange: (checked: boolean) => void;
  onCheckHealth: () => void;
  health?: RecoveryHealthCheck;
}) {
  return (
    <div className="wizard-step">
      <h2>Escolha o tipo de busca</h2>
      <div className="choice-grid compact">
        {modeCards.map((item) => (
          <RecoveryModeCard
            active={mode === item.id}
            icon={item.icon}
            key={item.id}
            title={item.title}
            text={item.text}
            onClick={() => onModeChange(item.id)}
          />
        ))}
      </div>

      <div className="recovery-options">
        <div className="form-panel recovery-form-panel">
          <strong>Tipos de arquivo</strong>
          <div className="chip-grid">
            {extensionChoices.map((extension) => (
              <label className="chip-check" key={extension}>
                <input checked={extensions.includes(extension)} type="checkbox" onChange={() => onExtensionToggle(extension)} />
                {extension.toUpperCase()}
              </label>
            ))}
          </div>
        </div>
        <div className="form-panel recovery-form-panel">
          <label className="toggle-line">
            <input checked={demo} type="checkbox" onChange={(event) => onDemoChange(event.target.checked)} />
            Modo demonstracao
          </label>
          <button className="icon-button label-button" type="button" onClick={onCheckHealth}>
            <Stethoscope size={18} />
            Ver saude
          </button>
          {health ? (
            <div className="health-simple">
              <StatusBadge status={health.status} label={health.label} />
              <p>{health.message}</p>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function RecoveryStepReview({
  problem,
  originPath,
  destinationPath,
  mode,
  demo,
  validation,
  onStart
}: {
  problem: RecoveryProblem;
  originPath: string;
  destinationPath: string;
  mode: RecoveryMode;
  demo: boolean;
  validation?: RecoveryPathValidation;
  onStart: () => void;
}) {
  return (
    <div className="wizard-step">
      <h2>Revisar antes de comecar</h2>
      <div className="review-grid">
        <span>
          <strong>O que aconteceu</strong>
          {problemLabel(problem)}
        </span>
        <span>
          <strong>Onde estavam</strong>
          {demo ? "Modo demonstracao" : originPath || "-"}
        </span>
        <span>
          <strong>Onde salvar</strong>
          {demo ? "Modo demonstracao" : destinationPath || "-"}
        </span>
        <span>
          <strong>Tipo de busca</strong>
          {demo ? "Modo demonstracao" : modeLabel(mode)}
        </span>
      </div>
      <RecoveryWarningBox>
        Pare de usar o dispositivo onde os arquivos estavam. O SafeDisk nao promete recuperacao garantida; ele tenta encontrar e salvar o que for possivel.
      </RecoveryWarningBox>
      {validation?.errors.map((error) => (
        <RecoveryWarningBox key={error}>{error}</RecoveryWarningBox>
      ))}
      <button className="icon-button label-button primary recovery-start-button" type="button" onClick={onStart}>
        <Play size={18} />
        Iniciar com seguranca
      </button>
    </div>
  );
}

function RecoveryWizard({
  locations,
  problem,
  originPath,
  destinationPath,
  mode,
  extensions,
  includeCommonFolders,
  demo,
  validation,
  health,
  step,
  setStep,
  setProblem,
  setOriginPath,
  setDestinationPath,
  setMode,
  setIncludeCommonFolders,
  setDemo,
  toggleExtension,
  validatePaths,
  checkHealth,
  start
}: {
  locations: RecoveryLocation[];
  problem: RecoveryProblem;
  originPath: string;
  destinationPath: string;
  mode: RecoveryMode;
  extensions: string[];
  includeCommonFolders: boolean;
  demo: boolean;
  validation?: RecoveryPathValidation;
  health?: RecoveryHealthCheck;
  step: number;
  setStep: (step: number) => void;
  setProblem: (problem: RecoveryProblem) => void;
  setOriginPath: (path: string) => void;
  setDestinationPath: (path: string) => void;
  setMode: (mode: RecoveryMode) => void;
  setIncludeCommonFolders: (checked: boolean) => void;
  setDemo: (checked: boolean) => void;
  toggleExtension: (extension: string) => void;
  validatePaths: () => void;
  checkHealth: () => void;
  start: () => void;
}) {
  return (
    <div className="recovery-workspace">
      <div className="wizard-steps" aria-label="Etapas">
        {["Aconteceu", "Origem", "Destino", "Busca", "Revisao"].map((label, index) => (
          <button className={step === index + 1 ? "is-active" : ""} key={label} type="button" onClick={() => setStep(index + 1)}>
            <span>{index + 1}</span>
            {label}
          </button>
        ))}
      </div>

      {step === 1 ? (
        <RecoveryStepProblem
          problem={problem}
          onSelect={(nextProblem, suggestedMode) => {
            setProblem(nextProblem);
            setMode(suggestedMode);
          }}
        />
      ) : null}
      {step === 2 ? (
        <RecoveryStepOrigin
          includeCommonFolders={includeCommonFolders}
          locations={locations}
          originPath={originPath}
          onChange={setOriginPath}
          onIncludeCommonFoldersChange={setIncludeCommonFolders}
        />
      ) : null}
      {step === 3 ? (
        <RecoveryStepDestination
          destinationPath={destinationPath}
          validation={validation}
          onChange={setDestinationPath}
          onValidate={validatePaths}
        />
      ) : null}
      {step === 4 ? (
        <RecoveryStepMode
          demo={demo}
          extensions={extensions}
          health={health}
          mode={mode}
          onCheckHealth={checkHealth}
          onDemoChange={setDemo}
          onExtensionToggle={toggleExtension}
          onModeChange={setMode}
        />
      ) : null}
      {step === 5 ? (
        <RecoveryStepReview
          demo={demo}
          destinationPath={destinationPath}
          mode={mode}
          originPath={originPath}
          problem={problem}
          validation={validation}
          onStart={start}
        />
      ) : null}

      <div className="wizard-actions">
        <button className="icon-button label-button" type="button" onClick={() => setStep(Math.max(1, step - 1))} disabled={step === 1}>
          <RotateCcw size={18} />
          Voltar
        </button>
        <button className="icon-button label-button primary" type="button" onClick={() => setStep(Math.min(5, step + 1))} disabled={step === 5}>
          <Play size={18} />
          Avancar
        </button>
      </div>
    </div>
  );
}

function RecoveryProgress({
  job,
  onCancel
}: {
  job?: RecoveryJobSnapshot;
  onCancel: () => void;
}) {
  if (!job) {
    return <div className="empty-state">Nenhuma busca em andamento.</div>;
  }

  return (
    <div className="job-panel recovery-job-panel">
      <div className="job-head">
        <div>
          <h2>{statusText(job)}</h2>
          <p className="detail-message">{job.phase}</p>
        </div>
        <div className="button-row">
          <StatusBadge status={job.status} />
          {isJobActive(job) ? (
            <button className="icon-button danger" title="Parar com seguranca" type="button" onClick={onCancel}>
              <Square size={18} />
            </button>
          ) : null}
        </div>
      </div>
      <ProgressBar value={job.progress} label={`${job.progress}%`} />
      <div className="summary-grid recovery-summary">
        <div className="summary-tile">
          <span>Arquivos encontrados</span>
          <strong>{job.foundCount}</strong>
        </div>
        <div className="summary-tile">
          <span>Arquivos salvos</span>
          <strong>{job.savedCount}</strong>
        </div>
        <div className="summary-tile">
          <span>Tipo de busca</span>
          <strong>{modeLabel(job.mode)}</strong>
        </div>
        <div className="summary-tile">
          <span>Processado</span>
          <strong>{formatBytes(job.processedBytes)}</strong>
        </div>
      </div>
      {job.currentItem ? <p className="detail-message">Agora: {job.currentItem}</p> : null}
      {job.warnings.map((warning) => (
        <RecoveryWarningBox key={warning}>{warning}</RecoveryWarningBox>
      ))}
      {job.errors.map((error) => (
        <RecoveryWarningBox key={error}>{error}</RecoveryWarningBox>
      ))}
      <RecoveryAdvancedDetails job={job} />
    </div>
  );
}

function RecoveryFilePreview({ file }: { file: RecoveryJobSnapshot["results"][number] }) {
  return (
    <tr>
      <td>{file.name}</td>
      <td>{categoryLabels[file.category]}</td>
      <td>{file.type.toUpperCase()}</td>
      <td>{formatBytes(file.sizeBytes)}</td>
      <td title={file.path}>{file.path}</td>
      <td>{file.message ?? "-"}</td>
    </tr>
  );
}

function RecoveryReportButton({ jobId, format }: { jobId: string; format: "txt" | "json" }) {
  return (
    <a className="icon-button label-button" href={api.recoveryReportUrl(jobId, format)}>
      <Download size={18} />
      {format.toUpperCase()}
    </a>
  );
}

function RecoveryResults({
  job,
  filter,
  setFilter,
  onOpenFolder,
  onNewSearch
}: {
  job?: RecoveryJobSnapshot;
  filter: RecoveryCategory | "all";
  setFilter: (filter: RecoveryCategory | "all") => void;
  onOpenFolder: () => void;
  onNewSearch: () => void;
}) {
  const files = useMemo(() => {
    if (!job) {
      return [];
    }
    return filter === "all" ? job.results : job.results.filter((file) => file.category === filter);
  }, [filter, job]);

  if (!job) {
    return <div className="empty-state">Nenhum resultado ainda.</div>;
  }

  return (
    <div className="recovery-results">
      <div className="summary-grid recovery-summary">
        <div className="summary-tile">
          <span>Arquivos encontrados</span>
          <strong>{job.foundCount}</strong>
        </div>
        <div className="summary-tile">
          <span>Arquivos salvos</span>
          <strong>{job.savedCount}</strong>
        </div>
        <div className="summary-tile">
          <span>Pasta escolhida</span>
          <strong>{job.destinationPath || "-"}</strong>
        </div>
        <div className="summary-tile">
          <span>Status</span>
          <StatusBadge status={job.status} />
        </div>
      </div>
      <div className="button-row result-actions">
        <button className="icon-button label-button" type="button" onClick={onOpenFolder}>
          <FolderOpen size={18} />
          Abrir pasta
        </button>
        <button className="icon-button label-button" type="button" onClick={onNewSearch}>
          <RefreshCw size={18} />
          Nova busca
        </button>
        <RecoveryReportButton format="txt" jobId={job.jobId} />
        <RecoveryReportButton format="json" jobId={job.jobId} />
      </div>
      <div className="segmented recovery-filter" role="group" aria-label="Filtrar resultados">
        {(Object.keys(categoryLabels) as Array<RecoveryCategory | "all">).map((category) => (
          <button className={filter === category ? "is-active" : ""} key={category} type="button" onClick={() => setFilter(category)}>
            {categoryLabels[category]}
          </button>
        ))}
      </div>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Arquivo</th>
              <th>Grupo</th>
              <th>Tipo</th>
              <th>Tamanho</th>
              <th>Pasta</th>
              <th>Observacao</th>
            </tr>
          </thead>
          <tbody>
            {files.length === 0 ? (
              <tr>
                <td colSpan={6}>Nenhum arquivo neste filtro.</td>
              </tr>
            ) : (
              files.map((file) => <RecoveryFilePreview file={file} key={file.id} />)
            )}
          </tbody>
        </table>
      </div>
      <RecoveryAdvancedDetails job={job} />
    </div>
  );
}

function RecoveryHistory({
  records,
  loading,
  onReload
}: {
  records: RecoveryHistoryRecord[];
  loading: boolean;
  onReload: () => void;
}) {
  return (
    <div className="recovery-history">
      <div className="page-header inline-header">
        <div>
          <h2>Historico do modulo</h2>
          <p>{loading ? "Carregando..." : `${records.length} registro(s)`}</p>
        </div>
        <button className="icon-button label-button" type="button" onClick={onReload} disabled={loading}>
          <RefreshCw size={18} />
          Atualizar
        </button>
      </div>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Data</th>
              <th>Problema</th>
              <th>Origem</th>
              <th>Destino</th>
              <th>Modo</th>
              <th>Encontrados</th>
              <th>Salvos</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {records.length === 0 ? (
              <tr>
                <td colSpan={8}>Nenhum historico gravado.</td>
              </tr>
            ) : (
              records.map((record) => (
                <tr key={record.id}>
                  <td>{formatDate(record.timestamp)}</td>
                  <td>{problemLabel(record.problem)}</td>
                  <td title={record.originPath}>{record.originPath}</td>
                  <td title={record.destinationPath}>{record.destinationPath}</td>
                  <td>{modeLabel(record.mode)}</td>
                  <td>{record.foundCount}</td>
                  <td>{record.savedCount}</td>
                  <td>
                    <span className={`status-badge status-${record.status === "erro" ? "error" : record.status === "cancelado" ? "canceled" : "success"}`}>
                      {record.status}
                    </span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ToolCard({ tool }: { tool: RecoveryToolInfo }) {
  return (
    <div className="tool-card">
      <strong>{tool.label}</strong>
      <StatusBadge status={tool.installed ? "success" : "unknown"} label={tool.installed ? "Encontrado" : "Opcional"} />
      <p>{tool.message}</p>
      {tool.path ? <small>{tool.path}</small> : null}
    </div>
  );
}

function RecoveryHelp({ tools, onReloadTools }: { tools?: RecoveryToolsDetection; onReloadTools: () => void }) {
  return (
    <div className="recovery-help">
      <div className="help-grid">
        <div className="form-panel help-panel">
          <h2>Se apagou arquivo</h2>
          <p>Pare de usar o disco, nao instale programas nesse mesmo disco e salve os encontrados em outro local.</p>
        </div>
        <div className="form-panel help-panel">
          <h2>Se pendrive pede para formatar</h2>
          <p>Nao formate. Use busca profunda e salve em outro disco.</p>
        </div>
        <div className="form-panel help-panel">
          <h2>Se HD faz barulho</h2>
          <p>Desligue, nao tente varias vezes e procure ajuda especializada.</p>
        </div>
        <div className="form-panel help-panel">
          <h2>Se for SSD</h2>
          <p>Em alguns SSDs, arquivos apagados podem ser limpos automaticamente pelo proprio dispositivo. A chance pode ser menor.</p>
        </div>
        <div className="form-panel help-panel">
          <h2>Se for celular</h2>
          <p>Verifique a lixeira da galeria, Google Fotos, iCloud, WhatsApp e backups antes de tentar outros metodos.</p>
        </div>
        <div className="form-panel help-panel">
          <h2>Procurar em backups</h2>
          <p>Lixeira, OneDrive, Google Drive, iCloud e Historico de Arquivos do Windows podem ter copias locais. O SafeDisk nao acessa contas online.</p>
        </div>
      </div>

      <div className="page-header inline-header">
        <div>
          <h2>Ferramentas externas</h2>
          <p>Integracoes preparadas, sempre com revisao antes de executar.</p>
        </div>
        <button className="icon-button label-button" type="button" onClick={onReloadTools}>
          <RefreshCw size={18} />
          Verificar
        </button>
      </div>
      <div className="tool-grid">
        {tools ? (
          <>
            <ToolCard tool={tools.windowsFileRecovery} />
            <ToolCard tool={tools.photoRec} />
            <ToolCard tool={tools.testDisk} />
            {tools.proprietary.map((tool) => (
              <ToolCard key={tool.id} tool={tool} />
            ))}
          </>
        ) : (
          <div className="empty-state">Clique em verificar para procurar ferramentas externas.</div>
        )}
      </div>
      <RecoveryAdvancedDetails tools={tools} />
    </div>
  );
}

function RecoveryHome({
  onStart,
  onHistory,
  onHelp,
  onDemo
}: {
  onStart: () => void;
  onHistory: () => void;
  onHelp: () => void;
  onDemo: () => void;
}) {
  return (
    <div className="recovery-home">
      <div className="recovery-hero">
        <div>
          <h1>Recuperacao de Arquivos</h1>
          <p>Vamos tentar encontrar arquivos apagados ou perdidos com seguranca.</p>
        </div>
        <FileSearch size={46} />
      </div>
      <RecoveryWarningBox>Pare de usar o dispositivo onde os arquivos estavam. Isso aumenta as chances de recuperacao.</RecoveryWarningBox>
      <div className="recovery-actions-grid">
        <button className="action-card" type="button" onClick={onStart}>
          <Wand2 size={22} />
          <strong>Comecar recuperacao</strong>
          <small>Fluxo guiado do inicio ao fim.</small>
        </button>
        <button className="action-card" type="button" onClick={onHistory}>
          <History size={22} />
          <strong>Ver historico</strong>
          <small>Buscas feitas neste computador.</small>
        </button>
        <button className="action-card" type="button" onClick={onHelp}>
          <HelpCircle size={22} />
          <strong>Ajuda rapida</strong>
          <small>Cuidados antes de tentar recuperar.</small>
        </button>
        <button className="action-card" type="button" onClick={onDemo}>
          <ClipboardList size={22} />
          <strong>Modo demonstracao</strong>
          <small>Testa a tela sem mexer em arquivos reais.</small>
        </button>
      </div>
    </div>
  );
}

export function Recovery({ notify }: { notify: Notify }) {
  const [view, setView] = useState<RecoveryView>("home");
  const [step, setStep] = useState(1);
  const [problem, setProblem] = useState<RecoveryProblem>("deleted-files");
  const [originPath, setOriginPath] = useState("");
  const [destinationPath, setDestinationPath] = useState("");
  const [mode, setMode] = useState<RecoveryMode>("quick");
  const [extensions, setExtensions] = useState<string[]>(["jpg", "png", "pdf", "docx", "xlsx", "mp4", "mp3", "zip"]);
  const [includeCommonFolders, setIncludeCommonFolders] = useState(false);
  const [demo, setDemo] = useState(false);
  const [locations, setLocations] = useState<RecoveryLocation[]>([]);
  const [validation, setValidation] = useState<RecoveryPathValidation>();
  const [health, setHealth] = useState<RecoveryHealthCheck>();
  const [tools, setTools] = useState<RecoveryToolsDetection>();
  const [historyRecords, setHistoryRecords] = useState<RecoveryHistoryRecord[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [job, setJob] = useState<RecoveryJobSnapshot>();
  const [filter, setFilter] = useState<RecoveryCategory | "all">("all");

  const loadLocations = useCallback(async () => {
    try {
      const result = await api.getRecoveryLocations();
      setLocations(result);
      setOriginPath((current) => current || result[0]?.path || "");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Falha ao listar locais.", "error");
    }
  }, [notify]);

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      setHistoryRecords(await api.getRecoveryHistory());
    } catch (error) {
      notify(error instanceof Error ? error.message : "Falha ao carregar historico.", "error");
    } finally {
      setHistoryLoading(false);
    }
  }, [notify]);

  const loadTools = useCallback(async () => {
    try {
      setTools(await api.detectRecoveryTools());
    } catch (error) {
      notify(error instanceof Error ? error.message : "Falha ao verificar ferramentas.", "error");
    }
  }, [notify]);

  useEffect(() => {
    void loadLocations();
  }, [loadLocations]);

  useEffect(() => {
    if (view === "history") {
      void loadHistory();
    }
  }, [loadHistory, view]);

  useEffect(() => {
    if (!isJobActive(job) || !job?.jobId) {
      return;
    }

    const timer = window.setInterval(async () => {
      try {
        const nextJob = await api.getRecoveryStatus(job.jobId);
        setJob(nextJob);
        if (!isJobActive(nextJob)) {
          setView("results");
          void loadHistory();
        }
      } catch (error) {
        notify(error instanceof Error ? error.message : "Falha ao atualizar recuperacao.", "error");
      }
    }, 850);

    return () => window.clearInterval(timer);
  }, [job, loadHistory, notify]);

  const validatePaths = useCallback(async () => {
    if (demo) {
      setValidation({ valid: true, warnings: ["Modo demonstracao: nenhum arquivo real sera analisado."], errors: [] });
      return;
    }
    try {
      const result = await api.validateRecoveryPaths(originPath, destinationPath);
      setValidation(result);
      notify(result.valid ? "Origem e destino validados." : "Ajuste origem e destino antes de iniciar.", result.valid ? "success" : "error");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Falha ao validar caminhos.", "error");
    }
  }, [demo, destinationPath, notify, originPath]);

  const checkHealth = useCallback(async () => {
    if (!originPath && !demo) {
      notify("Informe onde os arquivos estavam.", "info");
      return;
    }
    try {
      const result = demo
        ? {
            status: "healthy" as const,
            label: "Parece saudavel" as const,
            message: "Modo demonstracao.",
            advanced: { alerts: [], logs: ["demo"] }
          }
        : await api.checkRecoveryHealth(originPath);
      setHealth(result);
    } catch (error) {
      notify(error instanceof Error ? error.message : "Nao foi possivel verificar a saude.", "error");
    }
  }, [demo, notify, originPath]);

  const toggleExtension = useCallback((extension: string) => {
    setExtensions((current) =>
      current.includes(extension) ? current.filter((item) => item !== extension) : [...current, extension]
    );
  }, []);

  const start = useCallback(async () => {
    try {
      if (!demo) {
        const result = await api.validateRecoveryPaths(originPath, destinationPath);
        setValidation(result);
        if (!result.valid) {
          notify("Escolha outro destino antes de iniciar.", "error");
          return;
        }
      }

      const started = await api.startRecovery({
        problem,
        originPath: demo ? "C:\\SafeDiskDemoOrigem" : originPath,
        destinationPath: demo ? "D:\\SafeDiskDemoDestino" : destinationPath,
        mode: demo ? "demo" : mode,
        extensions,
        includeCommonFolders,
        demo
      });
      setJob(started);
      setView("progress");
      notify(demo ? "Demonstracao iniciada." : "Recuperacao iniciada.", "success");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Falha ao iniciar recuperacao.", "error");
    }
  }, [demo, destinationPath, extensions, includeCommonFolders, mode, notify, originPath, problem]);

  const cancel = useCallback(async () => {
    if (!job) {
      return;
    }
    try {
      setJob(await api.cancelRecovery(job.jobId));
      notify("Parando com seguranca.", "info");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Falha ao parar.", "error");
    }
  }, [job, notify]);

  const openFolder = useCallback(async () => {
    if (!job?.destinationPath) {
      notify("Nenhuma pasta de destino registrada.", "info");
      return;
    }
    try {
      await api.openRecoveredFolder(job.destinationPath);
    } catch (error) {
      notify(error instanceof Error ? error.message : "Nao foi possivel abrir a pasta.", "error");
    }
  }, [job?.destinationPath, notify]);

  function startDemo() {
    setDemo(true);
    setProblem("deleted-files");
    setMode("demo");
    setStep(5);
    setView("wizard");
  }

  function newSearch() {
    setStep(1);
    setDemo(false);
    setMode("quick");
    setValidation(undefined);
    setHealth(undefined);
    setFilter("all");
    setView("wizard");
  }

  return (
    <section className="page">
      <header className="page-header">
        <div>
          <h1>Recuperacao de Arquivos</h1>
          <p>Busca segura para arquivos apagados, perdidos ou sumidos.</p>
        </div>
        <div className="button-row">
          <button className={`icon-button label-button ${view === "home" ? "primary" : ""}`} type="button" onClick={() => setView("home")}>
            <FileSearch size={18} />
            Inicio
          </button>
          <button className={`icon-button label-button ${view === "wizard" ? "primary" : ""}`} type="button" onClick={newSearch}>
            <Wand2 size={18} />
            Assistente
          </button>
          <button className={`icon-button label-button ${view === "history" ? "primary" : ""}`} type="button" onClick={() => setView("history")}>
            <History size={18} />
            Historico
          </button>
          <button className={`icon-button label-button ${view === "help" ? "primary" : ""}`} type="button" onClick={() => setView("help")}>
            <HelpCircle size={18} />
            Ajuda
          </button>
        </div>
      </header>

      {view === "home" ? (
        <RecoveryHome
          onDemo={startDemo}
          onHelp={() => setView("help")}
          onHistory={() => setView("history")}
          onStart={() => {
            setStep(1);
            setView("wizard");
          }}
        />
      ) : null}

      {view === "wizard" ? (
        <RecoveryWizard
          checkHealth={checkHealth}
          demo={demo}
          destinationPath={destinationPath}
          extensions={extensions}
          health={health}
          includeCommonFolders={includeCommonFolders}
          locations={locations}
          mode={mode}
          originPath={originPath}
          problem={problem}
          setDemo={setDemo}
          setDestinationPath={setDestinationPath}
          setIncludeCommonFolders={setIncludeCommonFolders}
          setMode={setMode}
          setOriginPath={setOriginPath}
          setProblem={setProblem}
          setStep={setStep}
          start={start}
          step={step}
          toggleExtension={toggleExtension}
          validatePaths={validatePaths}
          validation={validation}
        />
      ) : null}

      {view === "progress" ? <RecoveryProgress job={job} onCancel={cancel} /> : null}

      {view === "results" ? (
        <RecoveryResults
          filter={filter}
          job={job}
          setFilter={setFilter}
          onNewSearch={newSearch}
          onOpenFolder={openFolder}
        />
      ) : null}

      {view === "history" ? <RecoveryHistory loading={historyLoading} records={historyRecords} onReload={loadHistory} /> : null}

      {view === "help" ? <RecoveryHelp tools={tools} onReloadTools={loadTools} /> : null}
    </section>
  );
}

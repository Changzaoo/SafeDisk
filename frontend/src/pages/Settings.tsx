import { CheckCircle2, Cloud, Monitor, RefreshCw, Save, Trash2 } from "lucide-react";
import { useState } from "react";
import { api } from "../api/client";
import { StatusBadge } from "../components/StatusBadge";
import type { SmartctlDetection } from "../types/disk";
import type { AppSettings } from "../App";

export function Settings({
  settings,
  setSettings,
  notify
}: {
  settings: AppSettings;
  setSettings: (settings: AppSettings) => void;
  notify: (message: string, tone?: "success" | "error" | "info") => void;
}) {
  const [smartctl, setSmartctl] = useState<SmartctlDetection>();
  const [cleanupRoot, setCleanupRoot] = useState("");
  const [olderThanHours, setOlderThanHours] = useState(24);
  const [apiUrl, setApiUrl] = useState(api.baseUrl);
  const [busy, setBusy] = useState(false);

  function patchSettings(partial: Partial<AppSettings>) {
    setSettings({ ...settings, ...partial });
  }

  async function checkSmartctl() {
    setBusy(true);
    try {
      setSmartctl(await api.getSmartctl());
      notify("Verificacao concluida.", "success");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Falha ao verificar smartctl.", "error");
    } finally {
      setBusy(false);
    }
  }

  async function cleanup() {
    setBusy(true);
    try {
      const result = await api.cleanupPartials(cleanupRoot, olderThanHours);
      notify(`${result.deleted.length} arquivo(s) .partial apagado(s).`, "success");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Falha na limpeza.", "error");
    } finally {
      setBusy(false);
    }
  }

  function saveApiUrl() {
    const next = api.setBaseUrl(apiUrl);
    setApiUrl(next);
    notify("Endereco da API atualizado. Atualize as telas para carregar os dados desse backend.", "success");
  }

  function useLocalBackend() {
    const next = api.resetBaseUrl();
    setApiUrl(next);
    notify("API local selecionada. O app usara 3335 e tentara 3336, 3340 ou 3341 se necessario.", "success");
  }

  function useCloudBackend() {
    const next = api.setBaseUrl(api.cloudBaseUrl);
    setApiUrl(next);
    notify("API da nuvem selecionada. Discos locais nao ficarao disponiveis.", "info");
  }

  return (
    <section className="page">
      <header className="page-header">
        <div>
          <h1>Configuracoes</h1>
          <p>Preferencias locais desta estacao</p>
        </div>
      </header>

      <div className="settings-grid">
        <div className="form-panel">
          <h2>Conexao da API</h2>
          <label>
            Backend ativo
            <input value={apiUrl} onChange={(event) => setApiUrl(event.target.value)} />
          </label>
          <div className="button-row">
            <button className="icon-button label-button" type="button" onClick={useLocalBackend}>
              <Monitor size={18} />
              Local
            </button>
            <button className="icon-button label-button" type="button" onClick={useCloudBackend}>
              <Cloud size={18} />
              Nuvem
            </button>
            <button className="icon-button label-button primary" type="button" onClick={saveApiUrl}>
              <Save size={18} />
              Salvar
            </button>
          </div>
          <div className="notice notice-warning inline-notice">
            <Cloud size={18} />
            <span>O padrao do SafeDisk e o backend local em 3335. A porta 3333 foi evitada para nao bater em outros projetos locais.</span>
          </div>
        </div>

        <div className="form-panel">
          <h2>Transferencia</h2>
          <label className="toggle-line">
            <input checked={settings.simulationDefault} type="checkbox" onChange={(event) => patchSettings({ simulationDefault: event.target.checked })} />
            Simulacao ativada por padrao
          </label>
          <label className="toggle-line">
            <input checked={settings.hashAlways} type="checkbox" onChange={(event) => patchSettings({ hashAlways: event.target.checked })} />
            Calcular hash sempre
          </label>
          <label>
            Margem minima (%)
            <input
              min={1}
              max={50}
              type="number"
              value={settings.minFreeMarginPercent}
              onChange={(event) => patchSettings({ minFreeMarginPercent: Number(event.target.value) })}
            />
          </label>
          <label>
            Margem minima (GB)
            <input
              min={0}
              type="number"
              value={settings.minFreeMarginGb}
              onChange={(event) => patchSettings({ minFreeMarginGb: Number(event.target.value) })}
            />
          </label>
        </div>

        <div className="form-panel">
          <h2>Logs</h2>
          <label>
            Caminho
            <input value={settings.logPath} onChange={(event) => patchSettings({ logPath: event.target.value })} />
          </label>
          <label>
            Pasta para limpar .partial
            <input value={cleanupRoot} onChange={(event) => setCleanupRoot(event.target.value)} placeholder="D:\\Backup" />
          </label>
          <label>
            Mais antigo que (horas)
            <input min={1} type="number" value={olderThanHours} onChange={(event) => setOlderThanHours(Number(event.target.value))} />
          </label>
          <button className="icon-button label-button danger" type="button" onClick={cleanup} disabled={busy || !cleanupRoot}>
            <Trash2 size={18} />
            Limpar
          </button>
        </div>

        <div className="form-panel">
          <h2>smartmontools</h2>
          <button className="icon-button label-button" type="button" onClick={checkSmartctl} disabled={busy}>
            <RefreshCw size={18} />
            Verificar smartctl
          </button>
          {smartctl ? (
            <div className={`notice ${smartctl.installed ? "notice-success" : "notice-warning"}`}>
              <CheckCircle2 size={18} />
              <span>{smartctl.installed ? smartctl.version ?? "Instalado" : smartctl.installHint}</span>
              <StatusBadge status={smartctl.installed ? "healthy" : "warning"} label={smartctl.installed ? "Instalado" : "Ausente"} />
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}

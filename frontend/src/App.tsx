import { useCallback, useEffect, useMemo, useState } from "react";
import { Sidebar, type PageId } from "./components/Sidebar";
import { Dashboard } from "./pages/Dashboard";
import { DiskHealth } from "./pages/DiskHealth";
import { History } from "./pages/History";
import { Settings } from "./pages/Settings";
import { Transfer } from "./pages/Transfer";

export interface AppSettings {
  simulationDefault: boolean;
  minFreeMarginPercent: number;
  minFreeMarginGb: number;
  hashAlways: boolean;
  logPath: string;
}

interface Toast {
  id: string;
  message: string;
  tone: "success" | "error" | "info";
}

const defaultSettings: AppSettings = {
  simulationDefault: true,
  minFreeMarginPercent: 5,
  minFreeMarginGb: 1,
  hashAlways: true,
  logPath: "..\\logs"
};

function readSettings(): AppSettings {
  const raw = window.localStorage.getItem("safe-disk-settings");
  if (!raw) {
    return defaultSettings;
  }

  try {
    return { ...defaultSettings, ...(JSON.parse(raw) as Partial<AppSettings>) };
  } catch {
    return defaultSettings;
  }
}

export default function App() {
  const [activePage, setActivePage] = useState<PageId>("dashboard");
  const [settings, setSettingsState] = useState<AppSettings>(() => readSettings());
  const [toasts, setToasts] = useState<Toast[]>([]);

  const setSettings = useCallback((next: AppSettings) => {
    setSettingsState(next);
    window.localStorage.setItem("safe-disk-settings", JSON.stringify(next));
  }, []);

  const notify = useCallback((message: string, tone: Toast["tone"] = "info") => {
    const id = crypto.randomUUID();
    setToasts((current) => [...current, { id, message, tone }]);
    window.setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, 4200);
  }, []);

  useEffect(() => {
    window.localStorage.setItem("safe-disk-settings", JSON.stringify(settings));
  }, [settings]);

  const page = useMemo(() => {
    switch (activePage) {
      case "health":
        return <DiskHealth notify={notify} />;
      case "transfer":
        return <Transfer settings={settings} notify={notify} />;
      case "history":
        return <History notify={notify} />;
      case "settings":
        return <Settings settings={settings} setSettings={setSettings} notify={notify} />;
      default:
        return <Dashboard notify={notify} />;
    }
  }, [activePage, notify, setSettings, settings]);

  return (
    <div className="app-shell">
      <Sidebar activePage={activePage} onChange={setActivePage} />
      <main className="app-main">{page}</main>
      <div className="toast-stack" aria-live="polite">
        {toasts.map((toast) => (
          <div className={`toast toast-${toast.tone}`} key={toast.id}>
            {toast.message}
          </div>
        ))}
      </div>
    </div>
  );
}

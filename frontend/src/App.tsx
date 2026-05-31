import { useCallback, useMemo, useState } from "react";
import { Sidebar, type PageId } from "./components/Sidebar";
import { Dashboard } from "./pages/Dashboard";
import { DiskHealth } from "./pages/DiskHealth";
import { History } from "./pages/History";
import { Recovery } from "./pages/Recovery";
import { Transfer } from "./pages/Transfer";

export interface TransferDefaults {
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

const transferDefaults: TransferDefaults = {
  simulationDefault: true,
  minFreeMarginPercent: 5,
  minFreeMarginGb: 1,
  hashAlways: true,
  logPath: "..\\logs"
};

export default function App() {
  const [activePage, setActivePage] = useState<PageId>("dashboard");
  const [toasts, setToasts] = useState<Toast[]>([]);

  const notify = useCallback((message: string, tone: Toast["tone"] = "info") => {
    const id = crypto.randomUUID();
    setToasts((current) => [...current, { id, message, tone }]);
    window.setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, 4200);
  }, []);

  const page = useMemo(() => {
    switch (activePage) {
      case "health":
        return <DiskHealth notify={notify} />;
      case "transfer":
        return <Transfer defaults={transferDefaults} notify={notify} />;
      case "recovery":
        return <Recovery notify={notify} />;
      case "history":
        return <History notify={notify} />;
      default:
        return <Dashboard notify={notify} onNavigate={setActivePage} />;
    }
  }, [activePage, notify]);

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

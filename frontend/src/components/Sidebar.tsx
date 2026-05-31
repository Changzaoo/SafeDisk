import { Activity, ArrowRightLeft, History, LayoutDashboard, Settings } from "lucide-react";

export type PageId = "dashboard" | "health" | "transfer" | "history" | "settings";

const items: Array<{ id: PageId; label: string; icon: typeof LayoutDashboard }> = [
  { id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { id: "health", label: "Saude", icon: Activity },
  { id: "transfer", label: "Transferencia", icon: ArrowRightLeft },
  { id: "history", label: "Historico", icon: History },
  { id: "settings", label: "Configuracoes", icon: Settings }
];

export function Sidebar({ activePage, onChange }: { activePage: PageId; onChange: (page: PageId) => void }) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-mark">
          <img alt="SafeDisk Transfer" className="brand-logo" src="/brand/safedisk-logo-192.png" />
        </span>
        <span>
          <strong>SafeDisk</strong>
          <small>Transfer</small>
        </span>
      </div>

      <nav className="nav-list" aria-label="Navegacao">
        {items.map((item) => {
          const Icon = item.icon;
          return (
            <button
              className={`nav-item ${activePage === item.id ? "is-active" : ""}`}
              key={item.id}
              type="button"
              onClick={() => onChange(item.id)}
              title={item.label}
            >
              <Icon size={19} />
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>
    </aside>
  );
}

import { useCallback, useEffect, useMemo, useState } from "react";
import { api, setApiAuthTokenProvider } from "./api/client";
import { configureFirebaseAuth, currentFirebaseToken, signInWithEmailPassword, signOutFirebase, subscribeFirebaseUser } from "./auth/firebaseAuth";
import { LoginScreen } from "./components/LoginScreen";
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

type AuthState =
  | { status: "loading" }
  | { status: "disabled" }
  | { status: "signedOut" }
  | { status: "signedIn"; email: string }
  | { status: "error"; message: string };

const transferDefaults: TransferDefaults = {
  simulationDefault: true,
  minFreeMarginPercent: 5,
  minFreeMarginGb: 1,
  hashAlways: true,
  logPath: "..\\logs"
};

function AuthStatus({ message }: { message: string }) {
  return (
    <main className="auth-page">
      <div className="auth-panel auth-status-panel">
        <span className="auth-mark">
          <img alt="SafeDisk Transfer" className="auth-logo" src="/brand/safedisk-logo-192.png" />
        </span>
        <div>
          <h1>SafeDisk</h1>
          <p>{message}</p>
        </div>
      </div>
    </main>
  );
}

export default function App() {
  const [activePage, setActivePage] = useState<PageId>("dashboard");
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [authState, setAuthState] = useState<AuthState>({ status: "loading" });

  const notify = useCallback((message: string, tone: Toast["tone"] = "info") => {
    const id = crypto.randomUUID();
    setToasts((current) => [...current, { id, message, tone }]);
    window.setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, 4200);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;

    async function bootAuth(): Promise<void> {
      try {
        const config = await api.getAuthConfig();
        if (cancelled) {
          return;
        }

        if (!config.authRequired) {
          setApiAuthTokenProvider(undefined);
          setAuthState({ status: "disabled" });
          return;
        }

        if (!config.firebase) {
          setAuthState({ status: "error", message: "Firebase Auth nao configurado no backend." });
          return;
        }

        await configureFirebaseAuth(config.firebase);
        if (cancelled) {
          return;
        }

        setApiAuthTokenProvider(currentFirebaseToken);
        unsubscribe = subscribeFirebaseUser((user) => {
          if (cancelled) {
            return;
          }

          setAuthState(user ? { status: "signedIn", email: user.email ?? "Usuario autenticado" } : { status: "signedOut" });
        });
      } catch (error) {
        if (!cancelled) {
          setAuthState({ status: "error", message: error instanceof Error ? error.message : "Falha ao preparar autenticacao." });
        }
      }
    }

    void bootAuth();

    return () => {
      cancelled = true;
      unsubscribe?.();
      setApiAuthTokenProvider(undefined);
    };
  }, []);

  const handleLogin = useCallback(async (email: string, password: string) => {
    await signInWithEmailPassword(email, password);
  }, []);

  const handleSignOut = useCallback(async () => {
    try {
      await signOutFirebase();
      notify("Sessao encerrada.", "info");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Falha ao sair.", "error");
    }
  }, [notify]);

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

  const toastStack = (
    <div className="toast-stack" aria-live="polite">
      {toasts.map((toast) => (
        <div className={`toast toast-${toast.tone}`} key={toast.id}>
          {toast.message}
        </div>
      ))}
    </div>
  );

  if (authState.status === "loading") {
    return <AuthStatus message="Preparando login..." />;
  }

  if (authState.status === "error") {
    return <AuthStatus message={authState.message} />;
  }

  if (authState.status === "signedOut") {
    return (
      <>
        <LoginScreen onLogin={handleLogin} />
        {toastStack}
      </>
    );
  }

  return (
    <div className="app-shell">
      <Sidebar
        activePage={activePage}
        onChange={setActivePage}
        userEmail={authState.status === "signedIn" ? authState.email : undefined}
        onSignOut={authState.status === "signedIn" ? handleSignOut : undefined}
      />
      <main className="app-main">{page}</main>
      {toastStack}
    </div>
  );
}

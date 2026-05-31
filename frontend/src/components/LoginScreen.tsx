import { KeyRound, LogIn, Mail, ShieldCheck } from "lucide-react";
import { type FormEvent, useState } from "react";

function loginErrorMessage(error: unknown): string {
  const code = typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : "";
  if (["auth/invalid-credential", "auth/user-not-found", "auth/wrong-password"].includes(code)) {
    return "Email ou senha invalidos.";
  }

  if (code === "auth/too-many-requests") {
    return "Muitas tentativas. Tente novamente em instantes.";
  }

  if (code === "auth/network-request-failed") {
    return "Falha de rede ao autenticar.";
  }

  return error instanceof Error ? error.message : "Nao foi possivel entrar.";
}

export function LoginScreen({ onLogin }: { onLogin: (email: string, password: string) => Promise<void> }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSubmitting(true);
    setError(undefined);

    try {
      await onLogin(email, password);
    } catch (loginError) {
      setError(loginErrorMessage(loginError));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="auth-page">
      <form className="auth-panel" onSubmit={handleSubmit}>
        <span className="auth-mark">
          <ShieldCheck size={28} />
        </span>
        <div>
          <h1>Entrar no SafeDisk</h1>
          <p>Use seu email e senha do Firebase.</p>
        </div>

        <label>
          Email
          <span className="auth-field">
            <Mail size={18} />
            <input autoComplete="email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
          </span>
        </label>

        <label>
          Senha
          <span className="auth-field">
            <KeyRound size={18} />
            <input
              autoComplete="current-password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </span>
        </label>

        {error ? <div className="auth-error">{error}</div> : null}

        <button className="icon-button primary auth-submit" type="submit" disabled={submitting}>
          <LogIn size={18} />
          {submitting ? "Entrando..." : "Entrar"}
        </button>
      </form>
    </main>
  );
}

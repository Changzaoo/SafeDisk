import { Buffer } from "node:buffer";
import type { NextFunction, Request, Response } from "express";
import { cert, getApps, initializeApp, type ServiceAccount } from "firebase-admin/app";
import { getAuth, type DecodedIdToken } from "firebase-admin/auth";

export interface FirebaseClientConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  appId?: string;
  messagingSenderId?: string;
  storageBucket?: string;
}

const PUBLIC_API_PATHS = new Set(["/api/health", "/api/auth/config"]);

function envValue(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (!value) {
    return fallback;
  }

  return ["1", "true", "yes", "sim", "on"].includes(value.trim().toLowerCase());
}

function normalizePrivateKey(value: string): string {
  return value.trim().replace(/^"|"$/g, "").replace(/\\n/g, "\n");
}

function parseServiceAccountJson(value: string): ServiceAccount | undefined {
  try {
    const parsed = JSON.parse(value) as {
      project_id?: string;
      projectId?: string;
      client_email?: string;
      clientEmail?: string;
      private_key?: string;
      privateKey?: string;
    };
    const projectId = parsed.project_id ?? parsed.projectId;
    const clientEmail = parsed.client_email ?? parsed.clientEmail;
    const privateKey = parsed.private_key ?? parsed.privateKey;

    if (!projectId || !clientEmail || !privateKey) {
      return undefined;
    }

    return {
      projectId,
      clientEmail,
      privateKey: normalizePrivateKey(privateKey)
    };
  } catch {
    return undefined;
  }
}

function getServiceAccount(): ServiceAccount | undefined {
  const base64Json = envValue("FIREBASE_SERVICE_ACCOUNT_JSON_BASE64");
  if (base64Json) {
    const decoded = Buffer.from(base64Json, "base64").toString("utf8");
    const serviceAccount = parseServiceAccountJson(decoded);
    if (serviceAccount) {
      return serviceAccount;
    }
  }

  const rawJson = envValue("FIREBASE_SERVICE_ACCOUNT_JSON");
  if (rawJson) {
    const serviceAccount = parseServiceAccountJson(rawJson);
    if (serviceAccount) {
      return serviceAccount;
    }
  }

  const projectId = envValue("FIREBASE_PROJECT_ID");
  const clientEmail = envValue("FIREBASE_CLIENT_EMAIL");
  const privateKey = envValue("FIREBASE_PRIVATE_KEY");
  if (!projectId || !clientEmail || !privateKey) {
    return undefined;
  }

  return {
    projectId,
    clientEmail,
    privateKey: normalizePrivateKey(privateKey)
  };
}

export function isAuthRequired(): boolean {
  return parseBoolean(process.env.AUTH_REQUIRED, false);
}

export function getAllowedEmails(): Set<string> {
  return new Set(
    (process.env.AUTH_ALLOWED_EMAILS ?? "")
      .split(/[,\n;]/)
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean)
  );
}

export function getFirebaseClientConfig(): FirebaseClientConfig | undefined {
  const projectId = envValue("FIREBASE_PROJECT_ID") ?? getServiceAccount()?.projectId;
  const apiKey = envValue("FIREBASE_WEB_API_KEY") ?? envValue("VITE_FIREBASE_API_KEY");

  if (!projectId || !apiKey) {
    return undefined;
  }

  return {
    apiKey,
    projectId,
    authDomain: envValue("FIREBASE_AUTH_DOMAIN") ?? `${projectId}.firebaseapp.com`,
    appId: envValue("FIREBASE_APP_ID"),
    messagingSenderId: envValue("FIREBASE_MESSAGING_SENDER_ID"),
    storageBucket: envValue("FIREBASE_STORAGE_BUCKET")
  };
}

function ensureFirebaseAdmin(): boolean {
  if (getApps().length > 0) {
    return true;
  }

  const serviceAccount = getServiceAccount();
  const projectId = serviceAccount?.projectId ?? envValue("FIREBASE_PROJECT_ID");
  if (!projectId) {
    return false;
  }

  if (serviceAccount) {
    initializeApp({
      credential: cert(serviceAccount),
      projectId
    });
    return true;
  }

  initializeApp({ projectId });
  return true;
}

async function verifyIdToken(token: string): Promise<DecodedIdToken> {
  let ready = false;
  try {
    ready = ensureFirebaseAdmin();
  } catch {
    // Report Firebase bootstrap failures as configuration errors, not as bad user credentials.
  }

  if (!ready) {
    const error = new Error("Firebase Auth nao configurado.");
    (error as { status?: number }).status = 503;
    throw error;
  }

  return getAuth().verifyIdToken(token, true);
}

function isPublicApiPath(path: string): boolean {
  return PUBLIC_API_PATHS.has(path);
}

export async function requireFirebaseAuth(request: Request, response: Response, next: NextFunction): Promise<void> {
  if (!isAuthRequired() || !request.path.startsWith("/api/") || isPublicApiPath(request.path)) {
    next();
    return;
  }

  const authorization = request.header("authorization") ?? "";
  const token = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) {
    response.setHeader("WWW-Authenticate", "Bearer");
    response.status(401).json({ error: "Login necessario." });
    return;
  }

  try {
    const decoded = await verifyIdToken(token);
    const allowedEmails = getAllowedEmails();
    const email = decoded.email?.toLowerCase();

    if (allowedEmails.size > 0 && (!email || !allowedEmails.has(email))) {
      response.status(403).json({ error: "Usuario sem permissao para acessar esta API." });
      return;
    }

    next();
  } catch (error) {
    const status = typeof (error as { status?: unknown }).status === "number" ? Number((error as { status: number }).status) : 401;
    response.setHeader("WWW-Authenticate", "Bearer");
    response.status(status).json({ error: status === 503 ? "Firebase Auth nao configurado." : "Sessao invalida ou expirada." });
  }
}

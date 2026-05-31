import cors from "cors";
import express, { type ErrorRequestHandler, type NextFunction, type Request, type Response } from "express";
import { getAllowedEmails, getFirebaseClientConfig, isAuthRequired, requireFirebaseAuth } from "./auth/firebaseAuth.js";
import { initializeDatabase } from "./db/database.js";
import { disksRouter } from "./routes/disks.routes.js";
import { historyRouter } from "./routes/history.routes.js";
import { relocationRouter } from "./routes/relocation.routes.js";
import { recoveryRouter } from "./routes/recovery.routes.js";
import { transferRouter } from "./routes/transfer.routes.js";
import { ensureLogDirectory, logEvent } from "./utils/logger.js";

const CONFIGURED_PORT = process.env.PORT?.trim();
const PARSED_PORT = CONFIGURED_PORT ? Number(CONFIGURED_PORT) : 3335;
const HAS_CONFIGURED_PORT = Number.isInteger(PARSED_PORT) && PARSED_PORT > 0;
const PREFERRED_PORT = HAS_CONFIGURED_PORT ? PARSED_PORT : 3335;
const PORT_CANDIDATES = CONFIGURED_PORT && HAS_CONFIGURED_PORT ? [PREFERRED_PORT] : [PREFERRED_PORT, 3336, 3340, 3341];
const IS_PRODUCTION = process.env.NODE_ENV === "production";
const DEFAULT_PRODUCTION_ORIGINS = ["https://safedisk.vercel.app", "https://safe-disk.vercel.app"];
const DEVELOPMENT_ORIGINS = [
  "http://localhost:3000",
  "http://localhost:5173",
  "http://localhost:5174",
  "http://127.0.0.1:3000",
  "http://127.0.0.1:5173",
  "http://127.0.0.1:5174"
];
const ALLOWED_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
const ALLOWED_HEADERS = ["Content-Type", "Authorization", "X-Requested-With"];
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60_000);
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX ?? 240);
const SENSITIVE_PATH_PATTERN =
  /^\/(?:\.env(?:\..*)?|env|secrets\.json|config\.json|\.git(?:\/.*)?|.*\.(?:pem|key))$/i;
const ADMIN_PATH_PATTERN = /^\/(?:admin|api\/admin|dashboard\/admin|painel|painel-admin|api\/private)(?:\/.*)?$/i;
const DISABLED_PRODUCTION_PATH_PATTERN =
  /^\/(?:swagger|api-docs|docs|openapi(?:\.json)?|swagger\.json|graphql|debug|diagnostics|diag|test|settings|config|server-status|api\/debug|api\/diagnostics|api\/diag|api\/test|api\/env|api\/config|api\/status|api\/server-status)(?:\/.*)?$/i;
const app = express();
app.set("trust proxy", 1);

initializeDatabase();
await ensureLogDirectory();

function parseAllowedOrigins(): Set<string> {
  const configuredValue = [process.env.CORS_ORIGINS, process.env.ALLOWED_ORIGINS]
    .filter((value): value is string => Boolean(value?.trim()))
    .join(",");
  const configured = (configuredValue || DEFAULT_PRODUCTION_ORIGINS.join(","))
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  return new Set([...configured, ...(!IS_PRODUCTION ? DEVELOPMENT_ORIGINS : [])]);
}

const allowedOrigins = parseAllowedOrigins();

function isAllowedOrigin(origin: string | undefined): boolean {
  return !origin || allowedOrigins.has(origin);
}

function decodedPath(request: Request): string {
  try {
    return decodeURIComponent(request.path).replace(/^\/+/, "/");
  } catch {
    return request.path.replace(/^\/+/, "/");
  }
}

function enforceHttps(request: Request, response: Response, next: NextFunction): void {
  if (!IS_PRODUCTION) {
    next();
    return;
  }

  const forwardedProto = request.header("x-forwarded-proto");
  const isHttps = request.secure || forwardedProto === "https";
  const host = request.header("host") ?? "";
  const isLocalhost = /^localhost(?::\d+)?$|^127\.0\.0\.1(?::\d+)?$/i.test(host);

  if (!isHttps && !isLocalhost && request.method === "GET") {
    response.redirect(301, `https://${host}${request.originalUrl}`);
    return;
  }

  next();
}

function applySecurityHeaders(_request: Request, response: Response, next: NextFunction): void {
  response.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'none'",
      "base-uri 'none'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "form-action 'none'"
    ].join("; ")
  );
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  response.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), payment=(), usb=(), bluetooth=(), magnetometer=(), gyroscope=(), accelerometer=()"
  );
  if (IS_PRODUCTION) {
    response.setHeader("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
  }
  next();
}

function blockSensitiveRoutes(request: Request, response: Response, next: NextFunction): void {
  const path = decodedPath(request);

  if (SENSITIVE_PATH_PATTERN.test(path)) {
    response.sendStatus(404);
    return;
  }

  if (ADMIN_PATH_PATTERN.test(path)) {
    response.setHeader("WWW-Authenticate", "Bearer");
    response.sendStatus(401);
    return;
  }

  if (DISABLED_PRODUCTION_PATH_PATTERN.test(path)) {
    response.sendStatus(404);
    return;
  }

  next();
}

const rateBuckets = new Map<string, { count: number; resetAt: number }>();

function rateLimitApi(request: Request, response: Response, next: NextFunction): void {
  if (!request.path.startsWith("/api/")) {
    next();
    return;
  }

  const now = Date.now();
  const key = request.ip || request.socket.remoteAddress || "unknown";
  const current = rateBuckets.get(key);
  const bucket = current && current.resetAt > now ? current : { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
  bucket.count += 1;
  rateBuckets.set(key, bucket);

  response.setHeader("RateLimit-Limit", String(RATE_LIMIT_MAX));
  response.setHeader("RateLimit-Remaining", String(Math.max(0, RATE_LIMIT_MAX - bucket.count)));
  response.setHeader("RateLimit-Reset", String(Math.ceil(bucket.resetAt / 1000)));

  if (bucket.count > RATE_LIMIT_MAX) {
    response.status(429).json({ error: "Muitas requisicoes. Tente novamente em instantes." });
    return;
  }

  next();
}

function rejectDisallowedCors(request: Request, response: Response, next: NextFunction): void {
  const origin = request.header("origin");
  if (origin && !isAllowedOrigin(origin)) {
    if (request.method === "OPTIONS") {
      response.sendStatus(403);
      return;
    }
    next();
    return;
  }

  if (origin) {
    response.header("Access-Control-Allow-Private-Network", "true");
  }
  next();
}

app.use(enforceHttps);
app.use(applySecurityHeaders);
app.use(blockSensitiveRoutes);
app.use(rejectDisallowedCors);

app.use(
  cors({
    origin(origin, callback) {
      callback(null, isAllowedOrigin(origin));
    },
    credentials: true,
    methods: ALLOWED_METHODS,
    allowedHeaders: ALLOWED_HEADERS,
    maxAge: 600,
    optionsSuccessStatus: 204
  })
);
app.use(rateLimitApi);
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (_request, response) => {
  response.json({ ok: true });
});

app.get("/api/auth/config", (_request, response) => {
  const firebase = getFirebaseClientConfig();
  if (isAuthRequired() && !firebase) {
    response.status(500).json({ error: "Firebase Auth nao configurado." });
    return;
  }

  response.json({
    authRequired: isAuthRequired(),
    firebase: firebase ?? null,
    emailAllowlistEnabled: getAllowedEmails().size > 0
  });
});

app.use(requireFirebaseAuth);

app.use("/api/disks", disksRouter);
app.use("/api/transfer", transferRouter);
app.use("/api/relocation", relocationRouter);
app.use("/api/recovery", recoveryRouter);
app.use("/api/history", historyRouter);

const errorHandler: ErrorRequestHandler = async (error, _request, response, _next) => {
  const message = error instanceof Error ? error.message : "Erro interno.";
  await logEvent("api.error", { message }).catch(() => undefined);
  const status = typeof (error as { status?: unknown }).status === "number" ? Number((error as { status: number }).status) : 400;
  const safeStatus = status >= 400 && status < 600 ? status : 500;
  const clientMessage = IS_PRODUCTION ? (safeStatus >= 500 ? "Erro interno." : "Requisicao invalida.") : message;
  response.status(safeStatus).json({ error: clientMessage });
};

app.use(errorHandler);

function listenOnAvailablePort(index = 0): void {
  const port = PORT_CANDIDATES[index];
  const server = app.listen(port, () => {
    console.log(`SafeDisk Transfer backend em http://localhost:${port}`);
  });

  server.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE" && !process.env.PORT && index < PORT_CANDIDATES.length - 1) {
      console.warn(`Porta ${port} em uso. Tentando ${PORT_CANDIDATES[index + 1]}...`);
      listenOnAvailablePort(index + 1);
      return;
    }

    throw error;
  });
}

listenOnAvailablePort();

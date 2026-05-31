import cors from "cors";
import express, { type ErrorRequestHandler } from "express";
import { initializeDatabase } from "./db/database.js";
import { disksRouter } from "./routes/disks.routes.js";
import { historyRouter } from "./routes/history.routes.js";
import { relocationRouter } from "./routes/relocation.routes.js";
import { transferRouter } from "./routes/transfer.routes.js";
import { ensureLogDirectory, logEvent } from "./utils/logger.js";

const PREFERRED_PORT = Number(process.env.PORT ?? 3333);
const PORT_CANDIDATES = process.env.PORT ? [PREFERRED_PORT] : [PREFERRED_PORT, 3335, 3336, 3340];
const app = express();

initializeDatabase();
await ensureLogDirectory();

const configuredOrigins = (process.env.FRONTEND_ORIGIN ?? "http://localhost:5173")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use((_request, response, next) => {
  response.header("Access-Control-Allow-Private-Network", "true");
  next();
});

app.use(
  cors({
    origin(origin, callback) {
      if (!origin) {
        callback(null, true);
        return;
      }

      const isConfigured = configuredOrigins.includes(origin);
      const isLocalDev = /^http:\/\/(localhost|127\.0\.0\.1):\d+$/i.test(origin);
      const isSafeDiskVercel = origin === "https://safedisk.vercel.app";
      const isVercelPreview = /^https:\/\/[a-z0-9-]+\.vercel\.app$/i.test(origin);
      callback(null, isConfigured || isLocalDev || isSafeDiskVercel || isVercelPreview);
    },
    optionsSuccessStatus: 204
  })
);
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (_request, response) => {
  response.json({ ok: true, service: "safe-disk-transfer-backend", timestamp: new Date().toISOString() });
});

app.use("/api/disks", disksRouter);
app.use("/api/transfer", transferRouter);
app.use("/api/relocation", relocationRouter);
app.use("/api/history", historyRouter);

const errorHandler: ErrorRequestHandler = async (error, _request, response, _next) => {
  const message = error instanceof Error ? error.message : "Erro interno.";
  await logEvent("api.error", { message }).catch(() => undefined);
  response.status(400).json({ error: message });
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

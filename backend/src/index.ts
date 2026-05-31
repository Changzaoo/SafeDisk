import cors from "cors";
import express, { type ErrorRequestHandler } from "express";
import { initializeDatabase } from "./db/database.js";
import { disksRouter } from "./routes/disks.routes.js";
import { historyRouter } from "./routes/history.routes.js";
import { relocationRouter } from "./routes/relocation.routes.js";
import { transferRouter } from "./routes/transfer.routes.js";
import { ensureLogDirectory, logEvent } from "./utils/logger.js";

const PORT = Number(process.env.PORT ?? 3333);
const app = express();

initializeDatabase();
await ensureLogDirectory();

const configuredOrigins = (process.env.FRONTEND_ORIGIN ?? "http://localhost:5173")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      if (!origin) {
        callback(null, true);
        return;
      }

      const isConfigured = configuredOrigins.includes(origin);
      const isLocalDev = /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin);
      const isVercelApp = /^https:\/\/[a-z0-9-]+\.vercel\.app$/i.test(origin);
      callback(null, isConfigured || isLocalDev || isVercelApp);
    }
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

app.listen(PORT, () => {
  console.log(`SafeDisk Transfer backend em http://localhost:${PORT}`);
});

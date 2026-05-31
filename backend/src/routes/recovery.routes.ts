import { Router } from "express";
import { detectRecoveryTools } from "../services/recovery-engines.service.js";
import {
  cancelRecoveryJob,
  checkStorageHealth,
  generateRecoveryReport,
  getRecoveryHistory,
  getRecoveryProgress,
  listAvailableLocations,
  openRecoveredFolder,
  startRecoveryJob,
  validateRecoveryPaths
} from "../services/recovery.service.js";

export const recoveryRouter = Router();

recoveryRouter.get("/locations", async (_request, response, next) => {
  try {
    response.json(await listAvailableLocations());
  } catch (error) {
    next(error);
  }
});

recoveryRouter.post("/validate-paths", async (request, response, next) => {
  try {
    response.json(await validateRecoveryPaths(request.body.originPath, request.body.destinationPath));
  } catch (error) {
    next(error);
  }
});

recoveryRouter.get("/health-check", async (request, response, next) => {
  try {
    response.json(await checkStorageHealth(request.query.originPath));
  } catch (error) {
    next(error);
  }
});

recoveryRouter.get("/tools", async (_request, response, next) => {
  try {
    response.json(await detectRecoveryTools());
  } catch (error) {
    next(error);
  }
});

recoveryRouter.post("/start", async (request, response, next) => {
  try {
    response.status(202).json(await startRecoveryJob(request.body));
  } catch (error) {
    next(error);
  }
});

recoveryRouter.get("/status/:jobId", (request, response) => {
  const status = getRecoveryProgress(request.params.jobId);
  if (!status) {
    response.status(404).json({ error: "Busca nao encontrada." });
    return;
  }
  response.json(status);
});

recoveryRouter.post("/cancel/:jobId", (request, response) => {
  const status = cancelRecoveryJob(request.params.jobId);
  if (!status) {
    response.status(404).json({ error: "Busca nao encontrada." });
    return;
  }
  response.json(status);
});

recoveryRouter.get("/history", (_request, response) => {
  response.json(getRecoveryHistory());
});

recoveryRouter.get("/report/:jobId", (request, response) => {
  const format = request.query.format === "json" ? "json" : "txt";
  const report = generateRecoveryReport(request.params.jobId, format);
  if (!report) {
    response.status(404).json({ error: "Relatorio nao encontrado." });
    return;
  }

  if (format === "json") {
    response.header("Content-Type", "application/json; charset=utf-8");
    response.attachment(`recovery-report-${request.params.jobId}.json`);
    response.send(report);
    return;
  }

  response.header("Content-Type", "text/plain; charset=utf-8");
  response.attachment(`recovery-report-${request.params.jobId}.txt`);
  response.send(report);
});

recoveryRouter.post("/open-folder", async (request, response, next) => {
  try {
    response.json(await openRecoveredFolder(request.body.path));
  } catch (error) {
    next(error);
  }
});

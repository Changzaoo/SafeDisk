import { Router } from "express";
import {
  cancelTransfer,
  cleanupPartialFiles,
  getTransferStatus,
  pauseTransfer,
  previewTransfer,
  resumeTransfer,
  startTransfer
} from "../services/transfer.service.js";

export const transferRouter = Router();

transferRouter.post("/preview", async (request, response, next) => {
  try {
    response.json(await previewTransfer(request.body));
  } catch (error) {
    next(error);
  }
});

transferRouter.post("/start", async (request, response, next) => {
  try {
    response.status(202).json(await startTransfer(request.body));
  } catch (error) {
    next(error);
  }
});

transferRouter.get("/status/:jobId", (request, response) => {
  const status = getTransferStatus(request.params.jobId);
  if (!status) {
    response.status(404).json({ error: "Job nao encontrado." });
    return;
  }
  response.json(status);
});

transferRouter.post("/cancel/:jobId", (request, response) => {
  const status = cancelTransfer(request.params.jobId);
  if (!status) {
    response.status(404).json({ error: "Job nao encontrado." });
    return;
  }
  response.json(status);
});

transferRouter.post("/pause/:jobId", (request, response) => {
  const status = pauseTransfer(request.params.jobId);
  if (!status) {
    response.status(404).json({ error: "Job nao encontrado." });
    return;
  }
  response.json(status);
});

transferRouter.post("/resume/:jobId", (request, response) => {
  const status = resumeTransfer(request.params.jobId);
  if (!status) {
    response.status(404).json({ error: "Job nao encontrado." });
    return;
  }
  response.json(status);
});

transferRouter.post("/cleanup-partials", async (request, response, next) => {
  try {
    response.json(await cleanupPartialFiles(request.body.root, request.body.olderThanHours));
  } catch (error) {
    next(error);
  }
});

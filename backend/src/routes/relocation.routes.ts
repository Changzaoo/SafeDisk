import { Router } from "express";
import { cancelRelocation, getRelocationStatus, previewRelocation, startRelocation } from "../services/relocation.service.js";

export const relocationRouter = Router();

relocationRouter.post("/preview", async (request, response, next) => {
  try {
    response.json(await previewRelocation(request.body));
  } catch (error) {
    next(error);
  }
});

relocationRouter.post("/start", async (request, response, next) => {
  try {
    response.status(202).json(await startRelocation(request.body));
  } catch (error) {
    next(error);
  }
});

relocationRouter.get("/status/:jobId", (request, response) => {
  const status = getRelocationStatus(request.params.jobId);
  if (!status) {
    response.status(404).json({ error: "Job de relocacao nao encontrado." });
    return;
  }
  response.json(status);
});

relocationRouter.post("/cancel/:jobId", (request, response) => {
  const status = cancelRelocation(request.params.jobId);
  if (!status) {
    response.status(404).json({ error: "Job de relocacao nao encontrado." });
    return;
  }
  response.json(status);
});

import { Router } from "express";
import { detectSmartctl } from "../services/smart.service.js";
import { getDiskById, getDiskHealth, getDisks } from "../services/disk.service.js";

export const disksRouter = Router();

disksRouter.get("/", async (_request, response, next) => {
  try {
    response.json(await getDisks());
  } catch (error) {
    next(error);
  }
});

disksRouter.get("/health", async (_request, response, next) => {
  try {
    response.json(await getDiskHealth());
  } catch (error) {
    next(error);
  }
});

disksRouter.get("/smartctl", async (_request, response, next) => {
  try {
    response.json(await detectSmartctl());
  } catch (error) {
    next(error);
  }
});

disksRouter.get("/:id", async (request, response, next) => {
  try {
    const disk = await getDiskById(request.params.id);
    if (!disk) {
      response.status(404).json({ error: "Disco nao encontrado." });
      return;
    }
    response.json(disk);
  } catch (error) {
    next(error);
  }
});

import { Router } from "express";
import { historyAsCsv, historyAsJson, listHistory } from "../services/storage.service.js";

export const historyRouter = Router();

historyRouter.get("/", (_request, response) => {
  response.json(listHistory());
});

historyRouter.get("/export", (request, response) => {
  const format = request.query.format === "csv" ? "csv" : "json";

  if (format === "csv") {
    response.header("Content-Type", "text/csv; charset=utf-8");
    response.attachment("safe-disk-transfer-history.csv");
    response.send(historyAsCsv());
    return;
  }

  response.header("Content-Type", "application/json; charset=utf-8");
  response.attachment("safe-disk-transfer-history.json");
  response.send(historyAsJson());
});

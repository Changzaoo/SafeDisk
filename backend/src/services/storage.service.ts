import { randomUUID } from "node:crypto";
import type { HistoryRecord } from "../types/transfer.js";
import { getDatabase } from "../db/database.js";

interface HistoryRow {
  id: string;
  timestamp: string;
  source_path: string;
  destination_path: string;
  size_bytes: number;
  hash_source?: string | null;
  hash_destination?: string | null;
  status: "success" | "error" | "canceled";
  error_message?: string | null;
}

function toHistoryRecord(row: HistoryRow): HistoryRecord {
  return {
    id: row.id,
    timestamp: row.timestamp,
    sourcePath: row.source_path,
    destinationPath: row.destination_path,
    sizeBytes: row.size_bytes,
    hashSource: row.hash_source ?? undefined,
    hashDestination: row.hash_destination ?? undefined,
    status: row.status,
    errorMessage: row.error_message ?? undefined
  };
}

export function saveHistoryRecord(record: Omit<HistoryRecord, "id" | "timestamp"> & Partial<Pick<HistoryRecord, "id" | "timestamp">>): HistoryRecord {
  const fullRecord: HistoryRecord = {
    id: record.id ?? randomUUID(),
    timestamp: record.timestamp ?? new Date().toISOString(),
    sourcePath: record.sourcePath,
    destinationPath: record.destinationPath,
    sizeBytes: record.sizeBytes,
    hashSource: record.hashSource,
    hashDestination: record.hashDestination,
    status: record.status,
    errorMessage: record.errorMessage
  };

  getDatabase()
    .prepare(
      `INSERT INTO transfer_history
        (id, timestamp, source_path, destination_path, size_bytes, hash_source, hash_destination, status, error_message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      fullRecord.id,
      fullRecord.timestamp,
      fullRecord.sourcePath,
      fullRecord.destinationPath,
      fullRecord.sizeBytes,
      fullRecord.hashSource ?? null,
      fullRecord.hashDestination ?? null,
      fullRecord.status,
      fullRecord.errorMessage ?? null
    );

  return fullRecord;
}

export function listHistory(limit = 500): HistoryRecord[] {
  const rows = getDatabase()
    .prepare(
      `SELECT id, timestamp, source_path, destination_path, size_bytes,
              hash_source, hash_destination, status, error_message
       FROM transfer_history
       ORDER BY timestamp DESC
       LIMIT ?`
    )
    .all(limit) as unknown as HistoryRow[];

  return rows.map(toHistoryRecord);
}

export function historyAsJson(): string {
  return JSON.stringify(listHistory(10000), null, 2);
}

function csvCell(value: unknown): string {
  const text = value == null ? "" : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

export function historyAsCsv(): string {
  const records = listHistory(10000);
  const header = [
    "id",
    "timestamp",
    "sourcePath",
    "destinationPath",
    "sizeBytes",
    "hashSource",
    "hashDestination",
    "status",
    "errorMessage"
  ];

  return [
    header.join(","),
    ...records.map((record) =>
      header
        .map((key) => csvCell(record[key as keyof HistoryRecord]))
        .join(",")
    )
  ].join("\n");
}

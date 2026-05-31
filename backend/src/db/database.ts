import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS transfer_history (
  id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL,
  source_path TEXT NOT NULL,
  destination_path TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  hash_source TEXT,
  hash_destination TEXT,
  status TEXT NOT NULL CHECK (status IN ('success', 'error', 'canceled')),
  error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_transfer_history_timestamp
ON transfer_history(timestamp DESC);

CREATE TABLE IF NOT EXISTS recovery_history (
  id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL,
  problem TEXT NOT NULL,
  origin_path TEXT NOT NULL,
  destination_path TEXT NOT NULL,
  mode TEXT NOT NULL,
  found_count INTEGER NOT NULL,
  saved_count INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('concluido', 'cancelado', 'erro')),
  notes TEXT,
  advanced_logs TEXT
);

CREATE INDEX IF NOT EXISTS idx_recovery_history_timestamp
ON recovery_history(timestamp DESC);
`;

let database: DatabaseSync | undefined;

function databaseUrlPath(): string | undefined {
  const value = process.env.DATABASE_URL?.trim();
  if (!value?.startsWith("file:")) {
    return undefined;
  }

  try {
    return fileURLToPath(new URL(value));
  } catch {
    return value.replace(/^file:/, "");
  }
}

export function getDatabasePath(): string {
  return process.env.SAFEDISK_DB_PATH ?? databaseUrlPath() ?? path.resolve(process.cwd(), "data", "safedisk.sqlite");
}

export function initializeDatabase(): DatabaseSync {
  if (database) {
    return database;
  }

  const dbPath = getDatabasePath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  database = new DatabaseSync(dbPath);
  database.exec("PRAGMA journal_mode = WAL;");
  database.exec("PRAGMA foreign_keys = ON;");
  database.exec(SCHEMA_SQL);
  return database;
}

export function getDatabase(): DatabaseSync {
  return initializeDatabase();
}

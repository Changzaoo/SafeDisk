import fs from "node:fs/promises";
import path from "node:path";

function defaultLogDirectory(): string {
  return process.env.SAFEDISK_LOG_DIR ?? path.resolve(process.cwd(), "..", "logs");
}

export function getLogDirectory(): string {
  return defaultLogDirectory();
}

export async function ensureLogDirectory(): Promise<void> {
  await fs.mkdir(getLogDirectory(), { recursive: true });
}

export async function logEvent(type: string, payload: Record<string, unknown>): Promise<void> {
  await ensureLogDirectory();
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    type,
    ...payload
  });

  await fs.appendFile(path.join(getLogDirectory(), "safe-disk-transfer.log"), `${line}\n`, "utf8");
}

export async function saveJsonLogFile(name: string, payload: unknown): Promise<string> {
  await ensureLogDirectory();
  const filePath = path.join(getLogDirectory(), name);
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2), "utf8");
  return filePath;
}

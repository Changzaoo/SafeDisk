import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface CommandResult {
  stdout: string;
  stderr: string;
}

const DEFAULT_TIMEOUT_MS = 12000;

async function runExecutable(file: string, args: string[], timeoutMs = DEFAULT_TIMEOUT_MS): Promise<CommandResult> {
  try {
    const result = await execFileAsync(file, args, {
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024 * 8,
      encoding: "utf8"
    });

    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? ""
    };
  } catch (error) {
    const details = error as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      killed?: boolean;
      signal?: string;
    };
    const message = [
      details.message,
      details.stderr ? `stderr: ${details.stderr}` : "",
      details.stdout ? `stdout: ${details.stdout}` : "",
      details.killed ? `signal: ${details.signal ?? "timeout"}` : ""
    ]
      .filter(Boolean)
      .join(" | ");

    throw new Error(message || `Falha ao executar ${file}`);
  }
}

export function runPowerShell(script: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<CommandResult> {
  return runExecutable(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
    timeoutMs
  );
}

export function runWmicDiskDrive(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<CommandResult> {
  return runExecutable(
    "wmic.exe",
    ["diskdrive", "get", "DeviceID,MediaType,Model,Size,Status", "/format:csv"],
    timeoutMs
  );
}

export function runSmartctl(args: string[], timeoutMs = DEFAULT_TIMEOUT_MS): Promise<CommandResult> {
  return runExecutable("smartctl.exe", args, timeoutMs);
}

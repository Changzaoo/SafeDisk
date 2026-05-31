import type { DiskHealthStatus, SmartAttribute, SmartReport, SmartctlDetection } from "../types/disk.js";
import { runSmartctl } from "../utils/commandRunner.js";

const INSTALL_HINT =
  "Instale o smartmontools pelo instalador oficial ou via winget: winget install smartmontools.smartmontools";

export async function detectSmartctl(): Promise<SmartctlDetection> {
  try {
    const { stdout } = await runSmartctl(["--version"], 5000);
    const firstLine = stdout.split(/\r?\n/).find(Boolean);
    return {
      installed: true,
      version: firstLine?.trim()
    };
  } catch (error) {
    return {
      installed: false,
      installHint: INSTALL_HINT,
      error: error instanceof Error ? error.message : "smartctl nao encontrado."
    };
  }
}

export async function listSmartDevices(): Promise<string[]> {
  try {
    const { stdout } = await runSmartctl(["--scan-open"], 8000);
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.split(/\s+/)[0])
      .filter((device) => device.startsWith("/dev/"));
  } catch {
    return [];
  }
}

export async function readSmartReport(device: string): Promise<SmartReport> {
  try {
    const { stdout, stderr } = await runSmartctl(["-a", device], 12000);
    return parseSmartctlOutput(stdout, device, stderr);
  } catch (error) {
    return {
      available: false,
      device,
      attributes: [],
      message: error instanceof Error ? error.message : "Falha ao ler SMART."
    };
  }
}

function parseNumber(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const match = value.match(/-?\d+/);
  return match ? Number(match[0]) : undefined;
}

function statusForAttribute(name: string, raw: string | undefined): DiskHealthStatus | undefined {
  const value = parseNumber(raw);
  if (value == null) {
    return undefined;
  }

  const normalized = name.toLowerCase();
  if (normalized.includes("reallocated") || normalized.includes("pending") || normalized.includes("uncorrect")) {
    if (value >= 50) {
      return "critical";
    }
    if (value > 0) {
      return "warning";
    }
  }

  if (normalized.includes("temperature")) {
    if (value >= 65) {
      return "critical";
    }
    if (value >= 55) {
      return "warning";
    }
  }

  if (normalized.includes("percentage_used") || normalized.includes("media_wearout")) {
    if (value >= 95) {
      return "critical";
    }
    if (value >= 80) {
      return "warning";
    }
  }

  return undefined;
}

function parseSmartAttribute(line: string): SmartAttribute | undefined {
  const match = line.match(/^\s*(\d+)\s+([\w-]+)\s+\S+\s+(\d+)\s+(\d+)\s+(\d+)\s+\S+\s+\S+\s+\S+\s+\S+\s+(.+)$/);
  if (!match) {
    return undefined;
  }

  const raw = match[6]?.trim();
  const attribute: SmartAttribute = {
    id: Number(match[1]),
    name: match[2],
    value: Number(match[3]),
    worst: Number(match[4]),
    threshold: Number(match[5]),
    raw,
    status: statusForAttribute(match[2], raw)
  };

  return attribute;
}

export function parseSmartctlOutput(output: string, device?: string, stderr?: string): SmartReport {
  const attributes = output
    .split(/\r?\n/)
    .map(parseSmartAttribute)
    .filter((attribute): attribute is SmartAttribute => Boolean(attribute));

  const overallText =
    output.match(/SMART overall-health self-assessment test result:\s*(.+)/i)?.[1] ??
    output.match(/SMART Health Status:\s*(.+)/i)?.[1];

  const temperatureC =
    parseNumber(output.match(/Temperature_Celsius[^\n]*\s(\d+)(?:\s|$)/i)?.[1]) ??
    parseNumber(output.match(/Current Drive Temperature:\s*(\d+)/i)?.[1]) ??
    parseNumber(output.match(/Temperature:\s*(\d+)\s*Celsius/i)?.[1]);

  const powerOnHours =
    parseNumber(output.match(/Power_On_Hours[^\n]*\s(\d+)(?:\s|$)/i)?.[1]) ??
    parseNumber(output.match(/Power On Hours:\s*([\d,]+)/i)?.[1]?.replace(/,/g, ""));

  const reallocatedSectors =
    parseNumber(output.match(/Reallocated_Sector_Ct[^\n]*\s(\d+)(?:\s|$)/i)?.[1]) ??
    parseNumber(output.match(/Reallocated_Event_Count[^\n]*\s(\d+)(?:\s|$)/i)?.[1]);

  const smartErrors =
    parseNumber(output.match(/ATA Error Count:\s*(\d+)/i)?.[1]) ??
    parseNumber(output.match(/Media and Data Integrity Errors:\s*(\d+)/i)?.[1]);

  const wearLevelPercent =
    parseNumber(output.match(/Percentage Used:\s*(\d+)%?/i)?.[1]) ??
    parseNumber(output.match(/Media_Wearout_Indicator[^\n]*\s(\d+)(?:\s|$)/i)?.[1]);

  return {
    available: true,
    device,
    overallPassed: overallText ? /passed|ok/i.test(overallText) : undefined,
    temperatureC,
    powerOnHours,
    reallocatedSectors,
    smartErrors,
    wearLevelPercent,
    attributes,
    message: stderr?.trim() || undefined
  };
}

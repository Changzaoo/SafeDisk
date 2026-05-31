export function formatBytes(value?: number): string {
  if (value == null || Number.isNaN(value)) {
    return "-";
  }

  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let size = Math.abs(value);
  let unit = 0;

  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }

  const signed = value < 0 ? -size : size;
  return `${signed.toLocaleString("pt-BR", {
    maximumFractionDigits: unit === 0 ? 0 : 1
  })} ${units[unit]}`;
}

export function formatDate(value: string): string {
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "medium"
  }).format(new Date(value));
}

export function percent(part: number | undefined, total: number | undefined): number {
  if (!part || !total || total <= 0) {
    return 0;
  }

  return Math.max(0, Math.min(100, (part / total) * 100));
}

export function shortHash(value?: string): string {
  return value ? `${value.slice(0, 10)}...${value.slice(-6)}` : "-";
}

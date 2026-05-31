import { HardDrive, Thermometer, Timer, Usb } from "lucide-react";
import type { DiskInfo } from "../types/disk";
import { formatBytes, percent } from "../utils/format";
import { ProgressBar } from "./ProgressBar";
import { StatusBadge } from "./StatusBadge";

export function DiskCard({
  disk,
  active,
  onSelect
}: {
  disk: DiskInfo;
  active?: boolean;
  onSelect?: (disk: DiskInfo) => void;
}) {
  const usedPercent = disk.usedBytes != null ? percent(disk.usedBytes, disk.sizeBytes) : 0;
  const Icon = disk.type === "USB" ? Usb : HardDrive;

  return (
    <button className={`disk-card ${active ? "is-active" : ""}`} type="button" onClick={() => onSelect?.(disk)}>
      <div className="disk-card-head">
        <span className="disk-icon">
          <Icon size={21} />
        </span>
        <span className="disk-title-wrap">
          <span className="disk-title">{disk.model}</span>
          <span className="disk-subtitle">
            {disk.type} {disk.busType ? `- ${disk.busType}` : ""}
          </span>
        </span>
        <StatusBadge status={disk.status} label={disk.statusLabel} />
      </div>

      <ProgressBar value={usedPercent} label={`${Math.round(usedPercent)}% usado`} />

      <div className="disk-metrics">
        <span>
          <strong>{formatBytes(disk.sizeBytes)}</strong>
          Total
        </span>
        <span>
          <strong>{formatBytes(disk.freeBytes)}</strong>
          Livre
        </span>
        <span>
          <strong>{disk.temperatureC != null ? `${disk.temperatureC} C` : "-"}</strong>
          <Thermometer size={14} /> Temp
        </span>
        <span>
          <strong>{disk.powerOnHours != null ? disk.powerOnHours.toLocaleString("pt-BR") : "-"}</strong>
          <Timer size={14} /> Horas
        </span>
      </div>
    </button>
  );
}

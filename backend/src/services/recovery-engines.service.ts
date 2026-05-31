import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { RecoveryToolInfo, RecoveryToolsDetection } from "../types/recovery.js";

const execFileAsync = promisify(execFile);

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function whereExecutable(name: string): Promise<string | undefined> {
  try {
    const result = await execFileAsync("where.exe", [name], {
      windowsHide: true,
      timeout: 5000,
      encoding: "utf8",
      maxBuffer: 1024 * 1024
    });
    return result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
  } catch {
    return undefined;
  }
}

function toolFolders(): string[] {
  return Array.from(
    new Set([
      path.resolve(process.cwd(), "tools"),
      path.resolve(process.cwd(), "..", "tools"),
      path.resolve(process.cwd(), "backend", "tools")
    ])
  );
}

async function findToolInToolsFolder(names: string[]): Promise<string | undefined> {
  for (const folder of toolFolders()) {
    for (const name of names) {
      const candidate = path.join(folder, name);
      if (await pathExists(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

function installedTool(id: string, label: string, toolPath: string, message: string): RecoveryToolInfo {
  return {
    id,
    label,
    installed: true,
    path: toolPath,
    message
  };
}

function missingTool(id: string, label: string, message: string): RecoveryToolInfo {
  return {
    id,
    label,
    installed: false,
    message
  };
}

export async function detectRecoveryTools(): Promise<RecoveryToolsDetection> {
  const [winfrPath, photoRecPath, testDiskPath] = await Promise.all([
    whereExecutable("winfr.exe"),
    findToolInToolsFolder(["photorec_win.exe", "photorec.exe", "photorec"]),
    findToolInToolsFolder(["testdisk_win.exe", "testdisk.exe", "testdisk"])
  ]);

  return {
    windowsFileRecovery: winfrPath
      ? installedTool(
          "windows-file-recovery",
          "Windows File Recovery",
          winfrPath,
          "Disponivel. O SafeDisk sempre mostra um resumo antes de usar ferramentas externas."
        )
      : missingTool(
          "windows-file-recovery",
          "Windows File Recovery",
          "Nao encontrado. Voce pode instalar pela Microsoft Store se quiser uma ferramenta oficial da Microsoft."
        ),
    photoRec: photoRecPath
      ? installedTool("photorec", "PhotoRec", photoRecPath, "Encontrado na pasta tools. Execucao automatica fica preparada para revisao do usuario.")
      : missingTool("photorec", "PhotoRec", "Nao encontrado. Coloque o executavel na pasta tools para preparar essa integracao."),
    testDisk: testDiskPath
      ? installedTool("testdisk", "TestDisk", testDiskPath, "Encontrado na pasta tools. Use com cuidado e confirme qualquer acao antes.")
      : missingTool("testdisk", "TestDisk", "Nao encontrado. Coloque o executavel na pasta tools para preparar essa integracao."),
    proprietary: [
      missingTool("recuva", "Recuva", "Opcao externa. Abra manualmente se precisar; o SafeDisk nao automatiza ferramentas fechadas."),
      missingTool("dmde", "DMDE", "Opcao externa. Abra manualmente se precisar; o SafeDisk nao automatiza ferramentas fechadas."),
      missingTool("r-studio", "R-Studio", "Opcao externa. Abra manualmente se precisar; o SafeDisk nao automatiza ferramentas fechadas."),
      missingTool("disk-drill", "Disk Drill", "Opcao externa. Abra manualmente se precisar; o SafeDisk nao automatiza ferramentas fechadas."),
      missingTool("easeus", "EaseUS", "Opcao externa. Abra manualmente se precisar; o SafeDisk nao automatiza ferramentas fechadas."),
      missingTool("stellar", "Stellar", "Opcao externa. Abra manualmente se precisar; o SafeDisk nao automatiza ferramentas fechadas.")
    ]
  };
}

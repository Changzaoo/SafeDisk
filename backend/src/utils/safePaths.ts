import path from "node:path";

const NULL_BYTE = /\0/;
const TRAVERSAL_SEGMENT = /(^|[\\/])\.\.([\\/]|$)/;
const WINDOWS_PROTECTED_SEGMENTS = [
  "windows",
  "programdata",
  "$recycle.bin",
  "system volume information",
  "recovery"
];

function normalizedAllowedRoots(): string[] {
  return (process.env.SAFEDISK_ALLOWED_ROOTS ?? "")
    .split(";")
    .map((root) => root.trim())
    .filter(Boolean)
    .map((root) => path.resolve(path.normalize(root.replace(/\//g, path.sep))));
}

function isSameOrChild(parent: string, child: string): boolean {
  const normalizedParent = path.resolve(parent);
  const normalizedChild = path.resolve(child);
  const parentWithSep = normalizedParent.endsWith(path.sep) ? normalizedParent : `${normalizedParent}${path.sep}`;

  return (
    normalizedChild.toLowerCase() === normalizedParent.toLowerCase() ||
    normalizedChild.toLowerCase().startsWith(parentWithSep.toLowerCase())
  );
}

function assertAllowedRoot(normalized: string): void {
  const allowedRoots = normalizedAllowedRoots();
  if (allowedRoots.length === 0) {
    return;
  }

  if (!allowedRoots.some((root) => isSameOrChild(root, normalized))) {
    throw new Error("Caminho fora das pastas permitidas.");
  }
}

function assertNotProtectedSystemPath(normalized: string): void {
  if (process.env.SAFEDISK_ALLOW_SYSTEM_PATHS === "1") {
    return;
  }

  const parsed = path.parse(normalized);
  if (normalized.toLowerCase() === parsed.root.toLowerCase()) {
    throw new Error("Operacao bloqueada na raiz do disco.");
  }

  const relative = path.relative(parsed.root, normalized).toLowerCase();
  const firstSegment = relative.split(/[\\/]/)[0];
  if (WINDOWS_PROTECTED_SEGMENTS.includes(firstSegment)) {
    throw new Error("Operacao bloqueada em pasta protegida do sistema.");
  }
}

export function sanitizePathInput(value: unknown, label = "path"): string {
  if (typeof value !== "string") {
    throw new Error(`${label} precisa ser texto.`);
  }

  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${label} nao pode ficar vazio.`);
  }

  if (trimmed.length > 4096 || NULL_BYTE.test(trimmed)) {
    throw new Error(`${label} contem caracteres invalidos.`);
  }

  if (TRAVERSAL_SEGMENT.test(trimmed)) {
    throw new Error(`${label} contem navegacao de diretorio invalida.`);
  }

  const normalized = path.normalize(trimmed.replace(/\//g, path.sep));
  if (!path.isAbsolute(normalized)) {
    throw new Error(`${label} precisa ser um caminho absoluto.`);
  }

  assertAllowedRoot(normalized);
  assertNotProtectedSystemPath(normalized);

  return normalized;
}

export function assertChildPath(parent: string, child: string): string {
  const normalizedParent = path.resolve(parent);
  const normalizedChild = path.resolve(child);

  if (!isSameOrChild(normalizedParent, normalizedChild)) {
    throw new Error("Caminho de destino fora da pasta selecionada.");
  }

  return normalizedChild;
}

export function safeJoin(parent: string, relativePath: string): string {
  if (path.isAbsolute(relativePath) || NULL_BYTE.test(relativePath)) {
    throw new Error("Nome relativo invalido.");
  }

  return assertChildPath(parent, path.join(parent, relativePath));
}

export function getDriveLetter(value: string): string | undefined {
  const normalized = path.normalize(value);
  const match = normalized.match(/^([a-zA-Z]):[\\/]/);
  return match?.[1]?.toUpperCase();
}

export function samePath(a: string, b: string): boolean {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

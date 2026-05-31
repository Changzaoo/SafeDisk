import path from "node:path";

const NULL_BYTE = /\0/;

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

  const normalized = path.normalize(trimmed.replace(/\//g, path.sep));
  if (!path.isAbsolute(normalized)) {
    throw new Error(`${label} precisa ser um caminho absoluto.`);
  }

  return normalized;
}

export function assertChildPath(parent: string, child: string): string {
  const normalizedParent = path.resolve(parent);
  const normalizedChild = path.resolve(child);
  const parentWithSep = normalizedParent.endsWith(path.sep) ? normalizedParent : `${normalizedParent}${path.sep}`;

  if (
    normalizedChild.toLowerCase() !== normalizedParent.toLowerCase() &&
    !normalizedChild.toLowerCase().startsWith(parentWithSep.toLowerCase())
  ) {
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

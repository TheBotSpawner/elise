import { SRC } from "./build-config";

const posix = (p: string) => p.replaceAll("\\", "/");

/** "use server" module → its key in the Desktop RPC allowlist (features/home/actions). */
export const actionKey = (file: string) =>
  posix(file)
    .slice(posix(SRC).length + 1)
    .replace(/\.(t|j)sx?$/, "");

/** Exported actions of a "use server" module (they must all be async functions). */
export const actionNames = (code: string) =>
  [...code.matchAll(/^export\s+async\s+function\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]!);

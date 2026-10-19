import { dirname, resolve } from "node:path";

const posix = (p: string) => p.replaceAll("\\", "/");

/**
 * The "@/…" key a renderer import resolves to, for Desktop's module overrides (ADR-081/092).
 * Vite applies the "@" alias before any plugin (even enforce: "pre"), and shared code also
 * imports relatively ("./actions"): every form maps to the same key. Matching the raw specifier
 * only used to miss every override, silently.
 */
export function overrideKey(source: string, importer: string | undefined, srcDir: string) {
  const src = posix(srcDir).replace(/\/$/, "");
  const spec = posix(
    source.startsWith(".") && importer ? resolve(dirname(importer.split("?")[0]!), source) : source,
  );
  return spec.startsWith(`${src}/`)
    ? `@/${spec.slice(src.length + 1).replace(/\.(t|j)sx?$/, "")}`
    : source;
}

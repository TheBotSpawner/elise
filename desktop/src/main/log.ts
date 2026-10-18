import { app } from "electron";
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Structured local logs (ADR-081), one JSON line per event. Redacted at the source: keys that
 * look like secrets are dropped and token-shaped strings are masked. Never uploaded by itself.
 */
const SECRET_KEY = /token|secret|password|authorization|cookie|verifier|code$|key$/i;
const SECRET_VALUE =
  /(eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}|ehh_[\w-]{20,}|sb-[\w-]+-auth-token[^\s;]*)/g;
const MAX_BYTES = 2 * 1024 * 1024;

export function redact(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return value.replace(SECRET_VALUE, "[redacted]").slice(0, 500);
  if (!value || typeof value !== "object" || depth > 4) return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [
      k,
      SECRET_KEY.test(k) ? "[redacted]" : redact(v, depth + 1),
    ]),
  );
}

let file: string | null = null;
const recent: string[] = [];

function target() {
  if (file) return file;
  const dir = join(app.getPath("userData"), "logs");
  mkdirSync(dir, { recursive: true });
  return (file = join(dir, "desktop.log"));
}

export function log(event: string, fields: Record<string, unknown> = {}) {
  const line = JSON.stringify({
    time: new Date().toISOString(),
    event,
    ...(redact(fields) as object),
  });
  recent.push(line);
  if (recent.length > 200) recent.shift();
  if (!app.isPackaged) console.log(line);
  try {
    const f = target();
    try {
      if (statSync(f).size > MAX_BYTES) renameSync(f, `${f}.1`);
    } catch {
      // first write
    }
    appendFileSync(f, `${line}\n`);
  } catch {
    // Logging never breaks the app.
  }
}

/** Recent sanitized events, for diagnostics the person chooses to copy. */
export const recentLogs = () => [...recent];

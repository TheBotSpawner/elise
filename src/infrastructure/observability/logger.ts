import { redactSensitive } from "./redaction";

type Level = "debug" | "info" | "warn" | "error";

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const minLevel: Level = process.env.NODE_ENV === "production" ? "info" : "debug";
const environment = process.env.ELISE_ENV ?? process.env.NODE_ENV ?? "development";

/**
 * Structured JSON logs (docs/engineering/18 §9). Log IDs, counts and metadata — never content
 * or secrets. Every field passes through redaction.
 */
function write(level: Level, event: string, fields: Record<string, unknown> = {}) {
  if (LEVELS[level] < LEVELS[minLevel]) return;
  const line = JSON.stringify({
    level,
    event,
    env: environment,
    time: new Date().toISOString(),
    ...(redactSensitive(fields) as Record<string, unknown>),
  });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const logger = {
  debug: (event: string, fields?: Record<string, unknown>) => write("debug", event, fields),
  info: (event: string, fields?: Record<string, unknown>) => write("info", event, fields),
  warn: (event: string, fields?: Record<string, unknown>) => write("warn", event, fields),
  error: (event: string, fields?: Record<string, unknown>) => write("error", event, fields),
};

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Local configuration of the ELISE Home Hub (ADR-079). Secrets stay on this machine: the hub's
 * ELISE credential and the local Home Assistant token are written to a file only this user can
 * read (0600). ELISE Desktop will keep them in the OS keychain instead (ADR-080); nothing here
 * is ever printed or sent to ELISE.
 */
export interface HubConfig {
  eliseUrl: string;
  hubId?: string;
  homeId?: string;
  hubToken?: string;
  haUrl: string;
  /** Prefer the HA_TOKEN environment variable; stored only if given at setup. */
  haToken?: string;
}

export const CONFIG_DIR = process.env.ELISE_HOME_DIR ?? join(homedir(), ".elise-home");
const FILE = join(CONFIG_DIR, "config.json");

export async function loadConfig(): Promise<HubConfig | null> {
  try {
    return JSON.parse(await readFile(FILE, "utf8")) as HubConfig;
  } catch {
    return null;
  }
}

export async function saveConfig(c: HubConfig): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  await writeFile(FILE, JSON.stringify(c, null, 2), { mode: 0o600 });
  await chmod(FILE, 0o600).catch(() => undefined); // Windows: ACLs, best effort
}

export const haTokenOf = (c: HubConfig) => process.env.HA_TOKEN ?? c.haToken ?? null;

/**
 * The hub only talks to a Home Assistant on this machine or the local network — never an
 * arbitrary URL (no local-network pivot): loopback, private ranges, *.local, homeassistant.
 */
export function isLocalProvider(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (!["http:", "https:"].includes(u.protocol)) return false;
  const h = u.hostname.replace(/^\[|\]$/g, "");
  return (
    h === "localhost" ||
    h === "homeassistant" ||
    h.endsWith(".local") ||
    /^127\./.test(h) ||
    /^10\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
    h === "::1"
  );
}

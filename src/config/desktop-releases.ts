import "server-only";

import { readFile } from "node:fs/promises";

import {
  DESKTOP_PLATFORMS,
  latestRelease,
  parseManifest,
  platformFromUserAgent,
  type DesktopChannel,
  type DesktopManifest,
  type DesktopPlatform,
  type DesktopRelease,
} from "@/core/platform/releases";

import { serverEnv } from "./server-env";

export { DESKTOP_PLATFORMS, platformFromUserAgent, type DesktopPlatform, type DesktopRelease };

/**
 * Where the web finds ELISE Desktop (ADR-082): ELISE_DESKTOP_MANIFEST_URL, the manifest the
 * release pipeline publishes next to the installers (https; a local file path is accepted in
 * development only). Cached for five minutes. Nothing configured, unreachable or malformed →
 * "no release", and the page says so honestly.
 */
const TTL_MS = 5 * 60_000;
let cache: { at: number; source: string; manifest: DesktopManifest | null } | null = null;

const production = () => serverEnv().ELISE_ENV === "production";

/** Beta builds show only where beta downloads are on: development, preview, or opted in. */
export function downloadChannel(): DesktopChannel {
  const explicit = serverEnv().ELISE_DESKTOP_DOWNLOAD_CHANNEL;
  if (explicit) return explicit;
  return production() ? "stable" : "beta";
}

async function loadManifest(): Promise<DesktopManifest | null> {
  const source = serverEnv().ELISE_DESKTOP_MANIFEST_URL;
  if (!source) return null;
  if (cache && cache.source === source && Date.now() - cache.at < TTL_MS) return cache.manifest;
  let manifest: DesktopManifest | null = null;
  try {
    if (/^https:\/\//.test(source) || (!production() && /^http:\/\//.test(source))) {
      const res = await fetch(source, { signal: AbortSignal.timeout(5000), cache: "no-store" });
      manifest = res.ok ? parseManifest(await res.json()) : null;
    } else if (!production()) {
      manifest = parseManifest(JSON.parse(await readFile(source, "utf8")));
    }
  } catch {
    manifest = null;
  }
  cache = { at: Date.now(), source, manifest };
  return manifest;
}

export async function desktopReleaseFor(platform: DesktopPlatform): Promise<DesktopRelease | null> {
  return latestRelease(await loadManifest(), {
    platform,
    channel: downloadChannel(),
    production: production(),
  });
}

/** Every platform with a release for this audience (the download page's "also for"). */
export async function desktopReleases(): Promise<DesktopRelease[]> {
  const out = await Promise.all(DESKTOP_PLATFORMS.map((p) => desktopReleaseFor(p)));
  return out.filter((r): r is DesktopRelease => r !== null);
}

/** For tests: forget the cached manifest. */
export const resetDesktopReleaseCache = () => (cache = null);

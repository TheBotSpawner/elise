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
 * Where the web finds ELISE Desktop (ADR-082/084). ELISE_DESKTOP_MANIFEST_URL is configured once
 * and never changes per release: a `{channel}` placeholder makes it one stable URL per channel
 * (…/desktop-{channel}/desktop-releases.json); the release workflow rewrites that file's content.
 * https only in production (a local path or http URL works in development). Cached five minutes.
 * Nothing configured, unreachable or malformed → "no release", and the page says so honestly.
 */
const TTL_MS = 5 * 60_000;
const cache = new Map<string, { at: number; manifest: DesktopManifest | null }>();

const production = () => serverEnv().ELISE_ENV === "production";

/** The manifest URL for one channel (a template, or one URL for every channel). */
export function manifestUrlFor(template: string, channel: DesktopChannel) {
  return template.replaceAll("{channel}", channel);
}

/**
 * Which builds this person may download: stable for everyone; beta (unsigned, internal) only in
 * development/preview, for ELISE admins, or when the deployment opts in explicitly.
 */
export function downloadChannel(options: { tester: boolean }): DesktopChannel {
  const explicit = serverEnv().ELISE_DESKTOP_DOWNLOAD_CHANNEL;
  if (explicit) return explicit;
  if (!production()) return "beta";
  return options.tester ? "beta" : "stable";
}

async function load(url: string): Promise<DesktopManifest | null> {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.manifest;
  let manifest: DesktopManifest | null = null;
  try {
    if (/^https:\/\//.test(url) || (!production() && /^http:\/\//.test(url))) {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000), cache: "no-store" });
      manifest = res.ok ? parseManifest(await res.json()) : null;
    } else if (!production()) {
      manifest = parseManifest(JSON.parse(await readFile(url, "utf8")));
    }
  } catch {
    manifest = null;
  }
  cache.set(url, { at: Date.now(), manifest });
  return manifest;
}

/** The channels' manifests this audience reads, merged (beta testers also see stable). */
async function manifestFor(channel: DesktopChannel): Promise<DesktopManifest | null> {
  const template = serverEnv().ELISE_DESKTOP_MANIFEST_URL;
  if (!template) return null;
  const urls = [
    ...new Set(
      (channel === "beta" ? (["beta", "stable"] as const) : (["stable"] as const)).map((c) =>
        manifestUrlFor(template, c),
      ),
    ),
  ];
  const all = (await Promise.all(urls.map(load))).filter((m): m is DesktopManifest => m !== null);
  return all.length ? { schemaVersion: 1, releases: all.flatMap((m) => m.releases) } : null;
}

export async function desktopReleaseFor(
  platform: DesktopPlatform,
  options: { tester: boolean },
): Promise<DesktopRelease | null> {
  const channel = downloadChannel(options);
  return latestRelease(await manifestFor(channel), {
    platform,
    channel,
    production: production(),
  });
}

/** Every platform with a release for this audience (the download page's "also for"). */
export async function desktopReleases(options: { tester: boolean }): Promise<DesktopRelease[]> {
  const out = await Promise.all(DESKTOP_PLATFORMS.map((p) => desktopReleaseFor(p, options)));
  return out.filter((r): r is DesktopRelease => r !== null);
}

/** For tests: forget cached manifests. */
export const resetDesktopReleaseCache = () => cache.clear();

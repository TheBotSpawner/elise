import "server-only";

import { z } from "zod";

import { serverEnv } from "./server-env";

/**
 * ELISE Desktop builds (ADR-080): release metadata from configuration, never URLs written in
 * components. No builds configured → the download page says Desktop isn't available yet
 * (no fake binaries).
 */
export const DESKTOP_PLATFORMS = ["windows", "macos"] as const;
export type DesktopPlatform = (typeof DESKTOP_PLATFORMS)[number];

const releaseSchema = z.object({
  platform: z.enum(DESKTOP_PLATFORMS),
  architecture: z.enum(["x64", "arm64"]).optional(),
  version: z.string().min(1).max(40),
  downloadUrl: z.url().refine((u) => u.startsWith("https://"), "https only"),
  minimumSupportedVersion: z.string().max(40).optional(),
});
export type DesktopRelease = z.infer<typeof releaseSchema>;

export function desktopReleases(): DesktopRelease[] {
  const raw = serverEnv().ELISE_DESKTOP_RELEASES;
  if (!raw) return [];
  try {
    return z.array(releaseSchema).max(10).parse(JSON.parse(raw));
  } catch {
    return [];
  }
}

/** The platform a browser most likely runs on (a suggestion: the person can pick another). */
export function platformFromUserAgent(ua: string | null): DesktopPlatform | null {
  if (!ua) return null;
  if (/Windows/i.test(ua)) return "windows";
  if (/Macintosh|Mac OS X/i.test(ua) && !/iPhone|iPad/i.test(ua)) return "macos";
  return null;
}

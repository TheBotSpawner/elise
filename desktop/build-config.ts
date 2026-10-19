import { fileURLToPath } from "node:url";

import { loadEnv } from "vite";

import { resolveCloudUrl } from "./cloud-url";

/**
 * Build-time configuration of ELISE Desktop (ADR-081). Everything here ends up inside a binary
 * people download, so it is public by definition: URLs, the Supabase publishable key, the update
 * feed. Server secrets are never read here.
 */
export const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
export const SRC = fileURLToPath(new URL("../src", import.meta.url));

export function desktopBuildConfig(mode: string) {
  const env = { ...loadEnv(mode, REPO_ROOT, ["NEXT_PUBLIC_", "ELISE_"]), ...process.env };
  const production = mode === "production";
  // Fails a packaged build that would talk to localhost (or to nothing).
  const cloudUrl = resolveCloudUrl(env.ELISE_CLOUD_URL, production);
  return {
    cloudUrl,
    supabaseUrl: env.NEXT_PUBLIC_SUPABASE_URL ?? "",
    supabasePublishableKey: env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "",
    updateFeed: env.ELISE_UPDATE_FEED ?? "",
    channel: env.ELISE_DESKTOP_CHANNEL === "beta" ? "beta" : "stable",
    googleMapsKey: env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? "",
  };
}
export type DesktopBuildConfig = ReturnType<typeof desktopBuildConfig>;

/**
 * Which ELISE Cloud a Desktop build talks to (ADR-081/084). Baked in at build time: changing
 * .env after the installer exists changes nothing. A packaged (production) build must point at a
 * real, https ELISE Cloud — never localhost — so a test build can't reach people by mistake.
 * Development builds default to the local web.
 */
const LOCAL_HOSTS = /^(localhost|0\.0\.0\.0|\[?::1\]?|127(?:\.\d{1,3}){3})$/i;

export class DesktopBuildConfigError extends Error {}

export function resolveCloudUrl(value: string | undefined, production: boolean): string {
  const raw = (value ?? "").trim().replace(/\/+$/, "");
  if (!production) return raw || "http://localhost:3000";
  if (!raw)
    throw new DesktopBuildConfigError(
      "Desktop production build requires a non-local ELISE_CLOUD_URL (it's missing).",
    );
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new DesktopBuildConfigError(`ELISE_CLOUD_URL isn't a URL: ${raw}`);
  }
  if (LOCAL_HOSTS.test(url.hostname) || url.hostname.endsWith(".local"))
    throw new DesktopBuildConfigError(
      `Desktop production build requires a non-local ELISE_CLOUD_URL (got ${url.origin}).`,
    );
  if (url.protocol !== "https:")
    throw new DesktopBuildConfigError(
      `Desktop production build requires an https ELISE_CLOUD_URL (got ${url.origin}).`,
    );
  return url.origin;
}

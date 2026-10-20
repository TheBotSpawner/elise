import { app, session, shell, type WebContents } from "electron";

import { cloudAppPath } from "@/core/platform/app-routes";
import { isSafeExternalUrl } from "@/core/platform/links";

import { log } from "./log";
import { APP_ORIGIN } from "./protocol";

/**
 * Secure by default (ADR-081, Electron security checklist): the app's own origin is the only
 * privileged content; navigation away is refused, new windows open in the system browser after
 * validation, permissions are denied unless ELISE's own page asks for something it uses.
 */
const ALLOWED_PERMISSIONS = new Set([
  "media", // the microphone, for voice
  // ADR-102: "Usar mi ubicación actual" — only asked when that setting is on (the renderer
  // decides), only for the app's own pages, and Windows' own location permission still applies.
  "geolocation",
  "notifications",
  "clipboard-sanitized-write",
  "fullscreen",
]);

/** Node's URL gives custom schemes an opaque origin ("null"): compare scheme and host. */
export const isAppUrl = (raw: string) => {
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}` === APP_ORIGIN;
  } catch {
    return false;
  }
};

/** In-app URL for a link to one of ELISE Cloud's screens (ADR-092), or null. */
export function inAppUrlFor(raw: string): string | null {
  try {
    const path = cloudAppPath(new URL(raw), __ELISE_BUILD__.cloudUrl);
    return path && `${APP_ORIGIN}${path}`;
  } catch {
    return null;
  }
}

export function openExternalSafely(url: string) {
  if (!isSafeExternalUrl(url)) {
    log("desktop_external_blocked", { url: url.slice(0, 80) });
    return;
  }
  void shell.openExternal(url);
}

/**
 * YouTube's embedded player refuses to play without a web page behind it (Error 153, "Video
 * player configuration error"): the app's own elise-app:// origin isn't one. Its embed requests
 * name ELISE's web address instead — only those, only the Referer.
 */
const YOUTUBE_EMBEDS = [
  "https://www.youtube-nocookie.com/embed/*",
  "https://www.youtube.com/embed/*",
];

export function hardenSessions() {
  const s = session.defaultSession;
  const referer = `${new URL(__ELISE_BUILD__.cloudUrl).origin}/`;
  s.webRequest.onBeforeSendHeaders({ urls: YOUTUBE_EMBEDS }, (details, callback) =>
    callback({ requestHeaders: { ...details.requestHeaders, Referer: referer } }),
  );
  s.setPermissionRequestHandler((wc, permission, callback, details) => {
    const ok = ALLOWED_PERMISSIONS.has(permission) && isAppUrl(details.requestingUrl);
    if (!ok) log("desktop_permission_denied", { permission });
    callback(ok);
  });
  s.setPermissionCheckHandler(
    (_wc, permission, origin) => ALLOWED_PERMISSIONS.has(permission) && origin === APP_ORIGIN,
  );

  app.on("web-contents-created", (_e, contents: WebContents) => {
    contents.on("will-navigate", (event, url) => {
      if (isAppUrl(url)) return;
      event.preventDefault();
      const inApp = inAppUrlFor(url);
      if (inApp) contents.loadURL(inApp).catch(() => undefined);
      else openExternalSafely(url);
    });
    contents.on("will-redirect", (event, url) => {
      if (!isAppUrl(url)) event.preventDefault();
    });
    contents.on("will-attach-webview", (event) => event.preventDefault());
    contents.setWindowOpenHandler(({ url }) => {
      // Never a privileged second window: in-app links stay here, the rest goes to the browser.
      const inApp = isAppUrl(url) ? url : inAppUrlFor(url);
      if (inApp) contents.loadURL(inApp).catch(() => undefined);
      else openExternalSafely(url);
      return { action: "deny" };
    });
  });
}

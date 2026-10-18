import { app, session, shell, type WebContents } from "electron";

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

export function openExternalSafely(url: string) {
  if (!isSafeExternalUrl(url)) {
    log("desktop_external_blocked", { url: url.slice(0, 80) });
    return;
  }
  void shell.openExternal(url);
}

export function hardenSessions() {
  const s = session.defaultSession;
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
      openExternalSafely(url);
    });
    contents.on("will-redirect", (event, url) => {
      if (!isAppUrl(url)) event.preventDefault();
    });
    contents.on("will-attach-webview", (event) => event.preventDefault());
    contents.setWindowOpenHandler(({ url }) => {
      // Never a privileged second window: in-app links stay here, the rest goes to the browser.
      if (isAppUrl(url)) contents.loadURL(url).catch(() => undefined);
      else openExternalSafely(url);
      return { action: "deny" };
    });
  });
}

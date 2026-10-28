import { protocol } from "electron";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";

import { cloudFetch } from "./cloud";
import { log } from "./log";

/**
 * elise-app://app — the local renderer (ADR-081). Assets come from inside the app, so ELISE
 * opens with the web frontend (or the whole internet) down. Only /api/* goes to ELISE Cloud,
 * through the main process, which adds the session; nothing else is ever fetched to boot.
 */
export const APP_SCHEME = "elise-app";
export const APP_ORIGIN = `${APP_SCHEME}://app`;

export function registerSchemes() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
    },
  ]);
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".gz": "application/gzip",
};

export function contentSecurityPolicy(dev: boolean) {
  const b = __ELISE_BUILD__;
  const supabase = b.supabaseUrl ? [b.supabaseUrl, b.supabaseUrl.replace(/^http/, "ws")] : [];
  const devServer = dev ? ["http://localhost:*", "ws://localhost:*"] : [];
  return [
    "default-src 'self'",
    // The same third-party players and maps the web uses; nothing else runs.
    // Development only adds the dev server and React Refresh's inline preamble.
    // Maps (ADR-104): scripts only from its two named hosts (never a wildcard script); its
    // data, tiles and fonts from Google's hosts, as on the web.
    `script-src 'self' https://sdk.scdn.co https://www.youtube.com https://maps.googleapis.com https://maps.gstatic.com ${dev ? `'unsafe-inline' ${devServer.join(" ")}` : ""}`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data: https://fonts.gstatic.com",
    "media-src 'self' data: blob: https:",
    `connect-src 'self' ${[...supabase, "https://*.googleapis.com", "https://*.gstatic.com", "https://*.google.com", ...devServer].join(" ")}`,
    // Plus Knowledge originals in ELISE's document viewer (signed Storage URLs).
    `frame-src https://www.youtube-nocookie.com https://www.youtube.com https://sdk.scdn.co ${supabase[0] ?? ""}`.trim(),
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

/**
 * The wake word recognizer's worker (ADR-095): its WebAssembly bindings need eval, so this one
 * response — a worker: no DOM, no cookies, no session — gets its own policy. Nothing else does.
 */
export const VOSK_WORKER_PATH = "/vosk-worker.js";
const WORKER_CSP =
  "default-src 'none'; script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'; connect-src 'self' data:";

/** Request headers the renderer may pass on; cookies and origin are the main process's job. */
const DROP = new Set(["cookie", "host", "origin", "referer", "x-elise-client", "connection"]);

async function proxy(request: Request, url: URL): Promise<Response> {
  const headers = new Headers();
  request.headers.forEach((v, k) => !DROP.has(k.toLowerCase()) && headers.set(k, v));
  try {
    const hasBody = !["GET", "HEAD"].includes(request.method);
    const res = await cloudFetch(url.pathname + url.search, {
      method: request.method,
      headers,
      ...(hasBody ? { body: request.body } : {}),
      signal: request.signal,
    });
    const out = new Headers(res.headers);
    out.delete("set-cookie");
    out.delete("content-encoding"); // fetch already decoded the body
    out.delete("content-length");
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out });
  } catch (error) {
    if ((error as Error).name === "AbortError") throw error;
    return Response.json(
      { error: { code: "CLOUD_UNAVAILABLE", message: "ELISE Cloud isn't reachable right now." } },
      { status: 503 },
    );
  }
}

/**
 * The wake word's model (ADR-095), shipped inside the app (resources/assets/wake): served at
 * elise-app://app/__wake/<file>, never from the network. Only known file names.
 */
async function wakeAsset(wakeDir: string, name: string): Promise<Response> {
  if (!/^[a-z0-9._-]{1,80}\.tar\.gz$/.test(name)) return new Response("Not found", { status: 404 });
  try {
    return new Response(await readFile(join(wakeDir, name)), {
      headers: { "content-type": "application/gzip", "cache-control": "no-store" },
    });
  } catch {
    log("desktop_wake_model_missing", { name });
    return new Response("Not found", { status: 404 });
  }
}

export function handleAppProtocol(
  rendererDir: string,
  devServerUrl: string | undefined,
  wakeDir: string,
) {
  const csp = contentSecurityPolicy(Boolean(devServerUrl));
  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.host !== "app") return new Response("Not found", { status: 404 });
    if (url.pathname.startsWith("/api/")) return proxy(request, url);
    if (url.pathname.startsWith("/__wake/")) return wakeAsset(wakeDir, url.pathname.slice(8));
    // Development: the Vite dev server (HMR). Production: files inside the app only.
    if (devServerUrl) {
      const res = await fetch(new URL(url.pathname + url.search, devServerUrl));
      const headers = new Headers(res.headers);
      if (headers.get("content-type")?.includes("text/html"))
        headers.set("content-security-policy", csp);
      if (url.pathname === VOSK_WORKER_PATH) headers.set("content-security-policy", WORKER_CSP);
      return new Response(res.body, { status: res.status, headers });
    }
    const wanted = decodeURIComponent(url.pathname);
    const asset = extname(wanted) !== "";
    const file = normalize(join(rendererDir, asset ? wanted : "index.html"));
    if (!file.startsWith(normalize(rendererDir) + sep))
      return new Response("Not found", { status: 404 });
    try {
      const body = await readFile(file);
      const type = TYPES[extname(file)] ?? "application/octet-stream";
      return new Response(body, {
        headers: {
          "content-type": type,
          ...(type.startsWith("text/html") ? { "content-security-policy": csp } : {}),
          ...(wanted === VOSK_WORKER_PATH ? { "content-security-policy": WORKER_CSP } : {}),
        },
      });
    } catch {
      if (asset) return new Response("Not found", { status: 404 });
      log("desktop_renderer_missing", { path: wanted });
      return new Response("ELISE couldn't load its interface. Reinstall ELISE Desktop.", {
        status: 500,
      });
    }
  });
}

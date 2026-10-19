import { randomBytes } from "node:crypto";

import { RuntimeError, type EngineCredentials } from "./backend";

/**
 * First run of ELISE's own engine (ADR-082): ELISE becomes its owner through Home Assistant's
 * onboarding API — the same endpoints its own setup uses (`/api/onboarding/*`, verified against
 * the pinned release) — then mints a long-lived token for itself with the documented
 * `auth/long_lived_access_token` WebSocket command. Nobody copies a token by hand. The engine
 * only listens on this computer (server_host 127.0.0.1), so nobody else can onboard it first.
 */
export async function bootstrapEngine(
  base: string,
  language: string,
  fetchImpl: typeof fetch = fetch,
  WebSocketImpl: typeof WebSocket = WebSocket,
): Promise<EngineCredentials> {
  const clientId = `${base}/`;
  const call = async (path: string, init: RequestInit) => {
    const res = await fetchImpl(`${base}${path}`, { ...init, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new RuntimeError("HOME_RUNTIME_BOOTSTRAP_FAILED", `${path} ${res.status}`);
    return res.json() as Promise<Record<string, unknown>>;
  };

  const steps = (await call("/api/onboarding", {})) as unknown as { step: string; done: boolean }[];
  if (steps.find((s) => s.step === "user")?.done)
    throw new RuntimeError(
      "HOME_RUNTIME_BOOTSTRAP_FAILED",
      "engine already has an owner ELISE doesn't hold credentials for",
    );

  const password = randomBytes(24).toString("base64url");
  const { auth_code } = await call("/api/onboarding/users", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      name: "ELISE",
      username: "elise",
      password,
      language: language === "es" ? "es" : "en",
    }),
  });
  const token = await call("/auth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: String(auth_code),
      client_id: clientId,
    }),
  });
  const access = String(token.access_token ?? "");
  if (!access) throw new RuntimeError("HOME_RUNTIME_BOOTSTRAP_FAILED", "no access token");
  const authed = { "content-type": "application/json", authorization: `Bearer ${access}` };
  // Finish the remaining onboarding steps so the engine is in a normal, configured state.
  await call("/api/onboarding/core_config", { method: "POST", headers: authed, body: "{}" });
  await call("/api/onboarding/analytics", { method: "POST", headers: authed, body: "{}" });
  await call("/api/onboarding/integration", {
    method: "POST",
    headers: authed,
    body: JSON.stringify({ client_id: clientId, redirect_uri: `${base}/?auth_callback=1` }),
  });

  const haToken = await longLivedToken(base.replace(/^http/, "ws"), access, WebSocketImpl);
  return { haUrl: base, haToken, ownerPassword: password };
}

function longLivedToken(wsBase: string, access: string, WS: typeof WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    const ws = new WS(`${wsBase}/api/websocket`);
    const timer = setTimeout(() => {
      ws.close();
      reject(new RuntimeError("HOME_RUNTIME_BOOTSTRAP_FAILED", "websocket timeout"));
    }, 30_000);
    ws.onmessage = (event) => {
      const msg = JSON.parse(String(event.data)) as {
        type: string;
        success?: boolean;
        result?: unknown;
      };
      if (msg.type === "auth_required")
        ws.send(JSON.stringify({ type: "auth", access_token: access }));
      else if (msg.type === "auth_ok")
        ws.send(
          JSON.stringify({
            id: 1,
            type: "auth/long_lived_access_token",
            client_name: "ELISE Desktop",
            lifespan: 3650,
          }),
        );
      else if (msg.type === "result") {
        clearTimeout(timer);
        ws.close();
        if (msg.success && typeof msg.result === "string") resolve(msg.result);
        else reject(new RuntimeError("HOME_RUNTIME_BOOTSTRAP_FAILED", "token refused"));
      } else if (msg.type === "auth_invalid") {
        clearTimeout(timer);
        ws.close();
        reject(new RuntimeError("HOME_RUNTIME_BOOTSTRAP_FAILED", "auth invalid"));
      }
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new RuntimeError("HOME_RUNTIME_BOOTSTRAP_FAILED", "websocket error"));
    };
  });
}

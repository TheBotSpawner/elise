import "server-only";

import { createHash, createHmac, randomUUID } from "node:crypto";

import { z } from "zod";

import { serverEnv } from "@/config/server-env";
import { AppError } from "@/core/errors";
import type { TuyaAcFan, TuyaAcMode } from "@/core/home/model";
import {
  TUYA_DIY_CATEGORY,
  tuyaDeviceSchema,
  tuyaKeysSchema,
  tuyaRemoteSchema,
  type TuyaDevice,
  type TuyaKeys,
  type TuyaRemote,
} from "@/core/home/tuya";
import { logger } from "@/infrastructure/observability/logger";

/**
 * Tuya's cloud OpenAPI (ADR-118), only documented endpoints, behind TUYA_ENABLED. ELISE's own
 * Smart Home project (client id + secret, server-only); requests signed with HMAC-SHA256 as
 * Tuya's "Sign Request" documents. The project token (grant_type=1) is cached until shortly
 * before it expires and refreshed with its refresh token; a rejected token is dropped and asked
 * again once.
 *
 * Resilience: a refusal of the project itself (bad signature or credentials) pauses Tuya for 10
 * minutes; a rate limit, 60 s. Lists are cached (devices 60 s, remotes and keys 10 min), so
 * opening Hogar or a voice command doesn't re-ask Tuya each time.
 */

const HOSTS = {
  us: "https://openapi.tuyaus.com",
  "us-e": "https://openapi-ueaz.tuyaus.com",
  eu: "https://openapi.tuyaeu.com",
  "eu-w": "https://openapi-weaz.tuyaeu.com",
  in: "https://openapi.tuyain.com",
  cn: "https://openapi.tuyacn.com",
  sg: "https://openapi-sg.iotbing.com",
} as const;
const TIMEOUT_MS = 8_000;
const DEVICES_CACHE_MS = 60_000;
const REMOTES_CACHE_MS = 10 * 60_000;
/** Tuya's codes for a token it no longer accepts (ask a new one, once). */
const TOKEN_CODES = new Set([1010, 1011]);
/** The project itself refused: signature, credentials, clock. Retrying won't help for a while. */
const PROJECT_CODES = new Set([1004, 1005, 1013, 2009]);

let openUntil = 0;
let token: { access: string; refresh: string; until: number } | null = null;
let asking: Promise<string> | null = null;
const cache = new Map<string, { at: number; value: unknown }>();

export const tuyaEnabled = () => serverEnv().TUYA_ENABLED === "true";

export function tuyaConfig() {
  const env = serverEnv();
  if (!tuyaEnabled() || !env.TUYA_CLIENT_ID || !env.TUYA_CLIENT_SECRET) return null;
  return {
    clientId: env.TUYA_CLIENT_ID,
    secret: env.TUYA_CLIENT_SECRET,
    host: HOSTS[env.TUYA_REGION],
    region: env.TUYA_REGION,
  };
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * Tuya's signature: `HMAC-SHA256(client_id [+ access_token] + t + nonce + stringToSign, secret)`
 * in upper-case hex, where stringToSign = METHOD \n SHA256(body) \n (no signed headers) \n
 * path?sorted query.
 */
export function tuyaSign(p: {
  clientId: string;
  secret: string;
  accessToken?: string;
  t: string;
  nonce: string;
  method: "GET" | "POST";
  path: string;
  query?: Record<string, string>;
  body?: string;
}): string {
  const q = Object.entries(p.query ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const url = q.length ? `${p.path}?${q.map(([k, v]) => `${k}=${v}`).join("&")}` : p.path;
  const stringToSign = [p.method, sha256(p.body ?? ""), "", url].join("\n");
  return createHmac("sha256", p.secret)
    .update(p.clientId + (p.accessToken ?? "") + p.t + p.nonce + stringToSign)
    .digest("hex")
    .toUpperCase();
}

const envelope = z.object({
  success: z.boolean(),
  code: z.coerce.number().optional(),
  msg: z.string().optional(),
  result: z.unknown().optional(),
});

export class TuyaError extends AppError {
  constructor(
    readonly tuyaCode: number | null,
    readonly httpStatus: number,
    endpoint: string,
  ) {
    const limited = httpStatus === 429 || tuyaCode === 40000309;
    super(
      limited ? "RATE_LIMITED" : "PROVIDER_UNAVAILABLE",
      limited
        ? "Smart Life is busy, try again in a moment"
        : tuyaCode === 1106 || tuyaCode === 28841105
          ? "ELISE's Tuya project isn't authorized for this (Tuya console: API products / permissions)"
          : "Smart Life didn't answer",
      { recovery: "retry", details: { tuyaCode, httpStatus, endpoint } },
    );
  }
}

async function send(
  method: "GET" | "POST",
  path: string,
  opts: { query?: Record<string, string>; body?: unknown; token?: string } = {},
) {
  const c = tuyaConfig();
  if (!c) throw new AppError("SERVER_NOT_CONFIGURED", "Smart Life isn't configured");
  const t = String(Date.now());
  const nonce = randomUUID();
  const body = opts.body === undefined ? "" : JSON.stringify(opts.body);
  const sign = tuyaSign({
    clientId: c.clientId,
    secret: c.secret,
    accessToken: opts.token,
    t,
    nonce,
    method,
    path,
    query: opts.query,
    body,
  });
  const qs = opts.query ? `?${new URLSearchParams(opts.query)}` : "";
  const started = Date.now();
  const r = await fetch(`${c.host}${path}${qs}`, {
    method,
    headers: {
      client_id: c.clientId,
      sign,
      t,
      nonce,
      sign_method: "HMAC-SHA256",
      ...(opts.token ? { access_token: opts.token } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body } : {}),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch((cause: unknown) => {
    throw new AppError("PROVIDER_UNAVAILABLE", "Smart Life didn't answer", { cause });
  });
  const json = envelope.safeParse(await r.json().catch(() => null));
  return {
    status: r.status,
    ms: Date.now() - started,
    ok: r.ok && json.success && json.data.success,
    code: json.success ? (json.data.code ?? null) : null,
    result: json.success ? json.data.result : undefined,
  };
}

const tokenResult = z.object({
  access_token: z.string().min(8),
  refresh_token: z.string().min(8),
  expire_time: z.coerce.number().int().positive(),
});

/** The project's token: cached, refreshed with its refresh token, asked anew when refused. */
async function accessToken(): Promise<string> {
  if (token && Date.now() < token.until) return token.access;
  asking ??= (async () => {
    const refreshed = token ? await send("GET", `/v1.0/token/${token.refresh}`) : null;
    // A refused refresh (expired, rotated by another instance) falls back to a new token.
    const r = refreshed?.ok
      ? refreshed
      : await send("GET", "/v1.0/token", { query: { grant_type: "1" } });
    const parsed = r.ok ? tokenResult.safeParse(r.result) : null;
    if (!parsed?.success) {
      token = null;
      if (r.code !== null && PROJECT_CODES.has(r.code)) openUntil = Date.now() + 10 * 60_000;
      logger.warn("tuya_token_failed", { status: r.status, code: r.code });
      throw new TuyaError(r.code, r.status, "/v1.0/token");
    }
    token = {
      access: parsed.data.access_token,
      refresh: parsed.data.refresh_token,
      // A minute early: never send one that expires on the way.
      until: Date.now() + Math.max(60, parsed.data.expire_time - 60) * 1000,
    };
    return token.access;
  })().finally(() => {
    asking = null;
  });
  return asking;
}

/** One documented business call; `shape` names it in logs without ids. */
async function api(
  method: "GET" | "POST",
  path: string,
  shape: string,
  opts: { query?: Record<string, string>; body?: unknown } = {},
): Promise<unknown> {
  if (Date.now() < openUntil) throw new AppError("PROVIDER_UNAVAILABLE", "Smart Life is paused");
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await send(method, path, { ...opts, token: await accessToken() });
    if (r.ok) {
      logger.info("tuya_call", { endpoint: shape, ms: r.ms });
      return r.result;
    }
    if (r.code !== null && TOKEN_CODES.has(r.code) && attempt === 0) {
      token = null;
      continue;
    }
    if (r.status === 429 || r.code === 40000309) openUntil = Date.now() + 60_000;
    if (r.code !== null && PROJECT_CODES.has(r.code)) openUntil = Date.now() + 10 * 60_000;
    logger.warn("tuya_call_failed", { endpoint: shape, status: r.status, code: r.code });
    throw new TuyaError(r.code, r.status, shape);
  }
  throw new TuyaError(null, 0, shape);
}

async function cached<T>(key: string, ms: number, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ms) return hit.value as T;
  const value = await load();
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 500) cache.clear();
  return value;
}

/** A Smart Life account's devices (GET /v1.0/users/{uid}/devices). */
export function tuyaUserDevices(uid: string): Promise<TuyaDevice[]> {
  return cached(`devices:${uid}`, DEVICES_CACHE_MS, async () => {
    const raw = await api("GET", `/v1.0/users/${encodeURIComponent(uid)}/devices`, "users/devices");
    return z
      .array(z.unknown())
      .catch([])
      .parse(raw)
      .flatMap((d) => {
        const p = tuyaDeviceSchema.safeParse(d);
        return p.success ? [p.data] : [];
      });
  });
}

/** The remotes set up on an infrared hub (GET /v2.0/infrareds/{id}/remotes). */
export function tuyaRemotes(infraredId: string): Promise<TuyaRemote[]> {
  return cached(`remotes:${infraredId}`, REMOTES_CACHE_MS, async () => {
    const raw = await api(
      "GET",
      `/v2.0/infrareds/${encodeURIComponent(infraredId)}/remotes`,
      "infrareds/remotes",
    );
    return z
      .array(z.unknown())
      .catch([])
      .parse(raw)
      .flatMap((r) => {
        const p = tuyaRemoteSchema.safeParse(r);
        return p.success ? [p.data] : [];
      });
  });
}

/** A remote's keys and, for an air conditioner, its ranges (GET …/remotes/{id}/keys). */
export function tuyaRemoteKeys(infraredId: string, remoteId: string): Promise<TuyaKeys> {
  return cached(`keys:${infraredId}:${remoteId}`, REMOTES_CACHE_MS, async () =>
    tuyaKeysSchema.parse(
      await api(
        "GET",
        `/v2.0/infrareds/${encodeURIComponent(infraredId)}/remotes/${encodeURIComponent(remoteId)}/keys`,
        "infrareds/remotes/keys",
      ),
    ),
  );
}

/**
 * One key. A standard remote takes Tuya's key name (POST …/command); a learned ("DIY", category
 * 999) one, its key id (POST …/raw/command).
 */
export async function tuyaSendKey(p: {
  infraredId: string;
  remoteId: string;
  categoryId: number;
  remoteIndex?: number;
  key: string;
  keyId?: number;
}): Promise<void> {
  const base = `/v2.0/infrareds/${encodeURIComponent(p.infraredId)}/remotes/${encodeURIComponent(p.remoteId)}`;
  if (p.categoryId === TUYA_DIY_CATEGORY)
    await api("POST", `${base}/raw/command`, "infrareds/remotes/raw/command", {
      body: {
        category_id: p.categoryId,
        ...(p.keyId !== undefined ? { key_id: p.keyId } : {}),
        key: p.key,
      },
    });
  else
    await api("POST", `${base}/command`, "infrareds/remotes/command", {
      body: {
        category_id: p.categoryId,
        key: p.key,
        ...(p.remoteIndex !== undefined ? { remote_index: p.remoteIndex } : {}),
      },
    });
}

const MODE_CODE: Record<TuyaAcMode, number> = { cool: 0, heat: 1, auto: 2, fan_only: 3, dry: 4 };
const FAN_CODE: Record<TuyaAcFan, number> = { auto: 0, low: 1, medium: 2, high: 3 };

/** An air conditioner's whole state (POST …/air-conditioners/{id}/scenes/command). */
export async function tuyaSendAc(p: {
  infraredId: string;
  remoteId: string;
  categoryId: number;
  remoteIndex?: number;
  power: boolean;
  mode?: TuyaAcMode;
  temp?: number;
  fan?: TuyaAcFan;
}): Promise<void> {
  await api(
    "POST",
    `/v2.0/infrareds/${encodeURIComponent(p.infraredId)}/air-conditioners/${encodeURIComponent(p.remoteId)}/scenes/command`,
    "infrareds/air-conditioners/scenes/command",
    {
      body: {
        power: p.power ? 1 : 0,
        ...(p.mode ? { mode: MODE_CODE[p.mode] } : {}),
        ...(p.temp !== undefined ? { temp: p.temp } : {}),
        ...(p.fan ? { wind: FAN_CODE[p.fan] } : {}),
        category_id: p.categoryId,
        ...(p.remoteIndex !== undefined ? { remote_index: p.remoteIndex } : {}),
      },
    },
  );
}

/** Tests only: forget the token, caches and pause. */
export function resetTuyaForTests() {
  openUntil = 0;
  token = null;
  asking = null;
  cache.clear();
}

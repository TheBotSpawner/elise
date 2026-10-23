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
  type TuyaRegion,
  type TuyaRemote,
} from "@/core/home/tuya";
import { logger } from "@/infrastructure/observability/logger";

/**
 * Tuya's cloud OpenAPI (ADR-118, ADR-119), only documented endpoints, behind TUYA_ENABLED.
 * ELISE's own cloud project (client id + secret, server-only), signed with HMAC-SHA256 as Tuya's
 * "Sign Requests for Cloud Authorization" documents.
 *
 * Whose data: every business call carries a `TuyaAuth` — the person's own token from OAuth 2.0
 * (`grant_type=2`, their data center), or, for the local check script only, the project's token
 * (`grant_type=1`). Nothing here holds a person's token: the application layer keeps it
 * encrypted and hands a getter in.
 *
 * Resilience: the project refused (signature, credentials, clock) pauses that data center 10 min;
 * a rate limit pauses that account 60 s. Lists are cached per account (devices 60 s, remotes and
 * keys 10 min) and forgotten on disconnect.
 */

const HOSTS: Record<TuyaRegion, string> = {
  us: "https://openapi.tuyaus.com",
  "us-e": "https://openapi-ueaz.tuyaus.com",
  eu: "https://openapi.tuyaeu.com",
  "eu-w": "https://openapi-weaz.tuyaeu.com",
  in: "https://openapi.tuyain.com",
  sg: "https://openapi-sg.iotbing.com",
  cn: "https://openapi.tuyacn.com",
};
const TIMEOUT_MS = 8_000;
const DEVICES_CACHE_MS = 60_000;
const REMOTES_CACHE_MS = 10 * 60_000;
/** Tuya's codes for a token it no longer accepts (refresh, then once more). */
const TOKEN_CODES = new Set([1010, 1011, 1012]);
/** The project itself refused: signature, credentials, clock. Retrying won't help for a while. */
const PROJECT_CODES = new Set([1004, 1005, 1013, 2009]);
const PERMISSION_CODES = new Set([1106, 28841105]);

const pausedRegion = new Map<TuyaRegion, number>();
const pausedAccount = new Map<string, number>();
const cache = new Map<string, { at: number; value: unknown }>();

export const tuyaEnabled = () => serverEnv().TUYA_ENABLED === "true";

/** The cloud project's credentials (the same project serves every data center it enables). */
export function tuyaConfig() {
  const env = serverEnv();
  if (!tuyaEnabled() || !env.TUYA_CLIENT_ID || !env.TUYA_CLIENT_SECRET) return null;
  return { clientId: env.TUYA_CLIENT_ID, secret: env.TUYA_CLIENT_SECRET };
}

export const tuyaHost = (region: TuyaRegion) => HOSTS[region];

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

/** What went wrong, in terms the person can act on (ADR-119 states). */
export type TuyaProblem =
  "token" | "project" | "rate_limited" | "quota" | "permission" | "wrong_region" | "unavailable";

export function classifyTuya(code: number | null, status: number, msg = ""): TuyaProblem {
  if (code !== null && TOKEN_CODES.has(code)) return "token";
  if (/data ?cent(er|re)s? inconsisten/i.test(msg)) return "wrong_region";
  if (/quota|exceed|insufficient|resource pack/i.test(msg)) return "quota";
  if (status === 429 || code === 40000309) return "rate_limited";
  if (code !== null && PERMISSION_CODES.has(code)) return "permission";
  if (code !== null && PROJECT_CODES.has(code)) return "project";
  return "unavailable";
}

export class TuyaError extends AppError {
  constructor(
    readonly problem: TuyaProblem,
    readonly tuyaCode: number | null,
    readonly httpStatus: number,
    endpoint: string,
  ) {
    super(
      problem === "rate_limited" || problem === "quota" ? "RATE_LIMITED" : "PROVIDER_UNAVAILABLE",
      {
        token: "Smart Life's authorization expired: reconnect",
        project: "ELISE's Smart Life setup was refused",
        rate_limited: "Smart Life is busy, try again in a moment",
        quota: "ELISE's Smart Life usage quota is used up",
        permission: "Smart Life didn't authorize this (service or permission not enabled)",
        wrong_region: "That Smart Life account is in another data center",
        unavailable: "Smart Life didn't answer",
      }[problem],
      {
        recovery: problem === "token" || problem === "wrong_region" ? "configure" : "retry",
        details: { tuyaProblem: problem, tuyaCode, httpStatus, endpoint },
      },
    );
  }
}

const envelope = z.object({
  success: z.boolean(),
  code: z.coerce.number().optional(),
  msg: z.string().optional(),
  result: z.unknown().optional(),
});

async function send(
  region: TuyaRegion,
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
  const r = await fetch(`${HOSTS[region]}${path}${qs}`, {
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
    msg: json.success ? (json.data.msg ?? "") : "",
    result: json.success ? json.data.result : undefined,
  };
}

const tokenResult = z.object({
  access_token: z.string().min(8),
  refresh_token: z.string().min(8),
  expire_time: z.coerce.number().int().positive(),
  uid: z.string().min(1).max(80),
});

export interface TuyaTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  uid: string;
}

async function tokenCall(
  region: TuyaRegion,
  path: string,
  query?: Record<string, string>,
): Promise<TuyaTokens> {
  if ((pausedRegion.get(region) ?? 0) > Date.now())
    throw new AppError("PROVIDER_UNAVAILABLE", "Smart Life is paused");
  const r = await send(region, "GET", path, query ? { query } : {});
  const parsed = r.ok ? tokenResult.safeParse(r.result) : null;
  if (!parsed?.success) {
    const problem = classifyTuya(r.code, r.status, r.msg);
    if (problem === "project") pausedRegion.set(region, Date.now() + 10 * 60_000);
    logger.warn("tuya_token_failed", { region, status: r.status, code: r.code, problem });
    throw new TuyaError(problem, r.code, r.status, "/v1.0/token");
  }
  return {
    accessToken: parsed.data.access_token,
    refreshToken: parsed.data.refresh_token,
    // A minute early: never send one that expires on the way.
    expiresAt: new Date(Date.now() + Math.max(60, parsed.data.expire_time - 60) * 1000),
    uid: parsed.data.uid,
  };
}

/** OAuth 2.0: the person's authorization code → their token (GET /v1.0/token?grant_type=2). */
export const exchangeTuyaCode = (region: TuyaRegion, code: string) =>
  tokenCall(region, "/v1.0/token", { grant_type: "2", code });

/** A token's refresh (GET /v1.0/token/{refresh_token}); the refresh token works once. */
export const refreshTuyaToken = (region: TuyaRegion, refreshToken: string) =>
  tokenCall(region, `/v1.0/token/${encodeURIComponent(refreshToken)}`);

/** Whose data a call reads: a token getter for one account in one data center. */
export interface TuyaAuth {
  region: TuyaRegion;
  /** Scopes caches and rate pauses (the ELISE connection id). */
  key: string;
  accessToken(): Promise<string>;
  /** Tuya refused the token: the next accessToken() must be a fresh one. */
  tokenRejected(): void;
}

const projectTokens = new Map<TuyaRegion, TuyaTokens>();

/** The cloud project's own token in one data center: the local check script only. */
export function projectAuth(region: TuyaRegion): TuyaAuth {
  return {
    region,
    key: `project:${region}`,
    async accessToken() {
      const t = projectTokens.get(region);
      if (t && t.expiresAt.getTime() > Date.now()) return t.accessToken;
      const fresh = await tokenCall(region, "/v1.0/token", { grant_type: "1" });
      projectTokens.set(region, fresh);
      return fresh.accessToken;
    },
    tokenRejected: () => void projectTokens.delete(region),
  };
}

/** One documented business call; `shape` names it in logs without ids. */
async function api(
  auth: TuyaAuth,
  method: "GET" | "POST",
  path: string,
  shape: string,
  opts: { query?: Record<string, string>; body?: unknown } = {},
): Promise<unknown> {
  if (
    (pausedRegion.get(auth.region) ?? 0) > Date.now() ||
    (pausedAccount.get(auth.key) ?? 0) > Date.now()
  )
    throw new AppError("PROVIDER_UNAVAILABLE", "Smart Life is paused");
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await send(auth.region, method, path, { ...opts, token: await auth.accessToken() });
    if (r.ok) {
      logger.info("tuya_call", { endpoint: shape, ms: r.ms });
      return r.result;
    }
    const problem = classifyTuya(r.code, r.status, r.msg);
    if (problem === "token" && attempt === 0) {
      auth.tokenRejected();
      continue;
    }
    if (problem === "rate_limited") pausedAccount.set(auth.key, Date.now() + 60_000);
    if (problem === "project") pausedRegion.set(auth.region, Date.now() + 10 * 60_000);
    logger.warn("tuya_call_failed", { endpoint: shape, status: r.status, code: r.code, problem });
    throw new TuyaError(problem, r.code, r.status, shape);
  }
  throw new TuyaError("token", null, 0, shape);
}

async function cached<T>(key: string, ms: number, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ms) return hit.value as T;
  const value = await load();
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 2000) cache.clear();
  return value;
}

/** Disconnect / reconnect: nothing of that account stays in memory. */
export function forgetTuyaAccount(key: string) {
  for (const k of cache.keys()) if (k.startsWith(`${key}|`)) cache.delete(k);
  pausedAccount.delete(key);
}

const list = <T>(raw: unknown, schema: z.ZodType<T>): T[] =>
  z
    .array(z.unknown())
    .catch([])
    .parse(raw)
    .flatMap((d) => {
      const p = schema.safeParse(d);
      return p.success ? [p.data] : [];
    });

/** A Smart Life account's devices (GET /v1.0/users/{uid}/devices), with that account's token. */
export function tuyaUserDevices(auth: TuyaAuth, uid: string, fresh = false): Promise<TuyaDevice[]> {
  const key = `${auth.key}|devices:${uid}`;
  if (fresh) cache.delete(key);
  return cached(key, DEVICES_CACHE_MS, async () =>
    list(
      await api(auth, "GET", `/v1.0/users/${encodeURIComponent(uid)}/devices`, "users/devices"),
      tuyaDeviceSchema,
    ),
  );
}

/** The remotes set up on an infrared hub (GET /v2.0/infrareds/{id}/remotes). */
export function tuyaRemotes(
  auth: TuyaAuth,
  infraredId: string,
  fresh = false,
): Promise<TuyaRemote[]> {
  const key = `${auth.key}|remotes:${infraredId}`;
  if (fresh) cache.delete(key);
  return cached(key, REMOTES_CACHE_MS, async () =>
    list(
      await api(
        auth,
        "GET",
        `/v2.0/infrareds/${encodeURIComponent(infraredId)}/remotes`,
        "infrareds/remotes",
      ),
      tuyaRemoteSchema,
    ),
  );
}

/** A remote's keys and, for an air conditioner, its ranges (GET …/remotes/{id}/keys). */
export function tuyaRemoteKeys(
  auth: TuyaAuth,
  infraredId: string,
  remoteId: string,
): Promise<TuyaKeys> {
  return cached(`${auth.key}|keys:${infraredId}:${remoteId}`, REMOTES_CACHE_MS, async () =>
    tuyaKeysSchema.parse(
      await api(
        auth,
        "GET",
        `/v2.0/infrareds/${encodeURIComponent(infraredId)}/remotes/${encodeURIComponent(remoteId)}/keys`,
        "infrareds/remotes/keys",
      ),
    ),
  );
}

export interface TuyaTarget {
  infraredId: string;
  remoteId: string;
  categoryId: number;
  remoteIndex?: number;
}

/**
 * One key. A standard remote takes Tuya's key name (POST …/command); a learned ("DIY", category
 * 999) one, its key id (POST …/raw/command).
 */
export async function tuyaSendKey(
  auth: TuyaAuth,
  p: TuyaTarget & { key: string; keyId?: number },
): Promise<void> {
  const base = `/v2.0/infrareds/${encodeURIComponent(p.infraredId)}/remotes/${encodeURIComponent(p.remoteId)}`;
  if (p.categoryId === TUYA_DIY_CATEGORY)
    await api(auth, "POST", `${base}/raw/command`, "infrareds/remotes/raw/command", {
      body: {
        category_id: p.categoryId,
        ...(p.keyId !== undefined ? { key_id: p.keyId } : {}),
        key: p.key,
      },
    });
  else
    await api(auth, "POST", `${base}/command`, "infrareds/remotes/command", {
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
export async function tuyaSendAc(
  auth: TuyaAuth,
  p: TuyaTarget & { power: boolean; mode?: TuyaAcMode; temp?: number; fan?: TuyaAcFan },
): Promise<void> {
  await api(
    auth,
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

/** Tests only: forget tokens, caches and pauses. */
export function resetTuyaForTests() {
  pausedRegion.clear();
  pausedAccount.clear();
  projectTokens.clear();
  cache.clear();
}

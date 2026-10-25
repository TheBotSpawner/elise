import "server-only";

import { createHmac, createSign, timingSafeEqual } from "node:crypto";

import { serverEnv } from "@/config/server-env";
import { AppError } from "@/core/errors";
import type { OcrProvider } from "@/core/knowledge/extraction";
import { logger } from "@/infrastructure/observability/logger";
import { recordUsage } from "@/infrastructure/observability/usage";

/**
 * Google Document AI, Enterprise Document OCR (ADR-035). Online processing: up to 15 pages per
 * request (individual pages selected, so a mixed PDF only sends the scanned ones), up to 40 MB.
 * Document AI takes no API keys: it needs a short-lived OAuth token of the OCR service account,
 * obtained one of three ways (ADR-121), never in the browser:
 * - on Vercel, Workload Identity Federation: Vercel's OIDC token is exchanged at Google for the
 *   account's one-hour token — no key exists anywhere;
 * - in background jobs (Trigger.dev, which has no identity Google can trust), that one-hour token
 *   is asked of ELISE's own broker on Vercel, in a request signed with OCR_BROKER_SECRET;
 * - a JSON key, only where an organization still allows creating them.
 */

const SCOPE = "https://www.googleapis.com/auth/cloud-platform";

type Token = { value: string; expires: number };
type TokenSource = () => Promise<Token>;

interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

interface Federation {
  projectNumber: string;
  pool: string;
  provider: string;
  serviceAccount: string;
}

function account(raw: string): ServiceAccount {
  const text = raw.trim().startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8");
  const parsed = JSON.parse(text) as ServiceAccount;
  if (!parsed.client_email || !parsed.private_key)
    throw new AppError("AI_NOT_CONFIGURED", "The OCR service account key is incomplete");
  return parsed;
}

const b64url = (s: string | Buffer) => Buffer.from(s).toString("base64url");

const rejected = (step: string, status: number) =>
  new AppError("AI_NOT_CONFIGURED", "Google rejected the OCR credentials", {
    recovery: "configure",
    details: { step, status },
  });

const postJson = (url: string, body: unknown, bearer?: string) =>
  fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });

/** A JSON key: an OAuth token from a JWT signed with it. */
function keyTokens(sa: ServiceAccount): TokenSource {
  return async () => {
    const now = Math.floor(Date.now() / 1000);
    const uri = sa.token_uri ?? "https://oauth2.googleapis.com/token";
    const unsigned = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(
      JSON.stringify({ iss: sa.client_email, scope: SCOPE, aud: uri, iat: now, exp: now + 3600 }),
    )}`;
    const signature = createSign("RSA-SHA256").update(unsigned).sign(sa.private_key);
    const res = await fetch(uri, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: `${unsigned}.${b64url(signature)}`,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw rejected("key", res.status);
    const body = (await res.json()) as { access_token: string; expires_in: number };
    return { value: body.access_token, expires: Date.now() + body.expires_in * 1000 };
  };
}

/**
 * Workload Identity Federation: Vercel's OIDC token → Google STS (a federated token) → the OCR
 * service account's one-hour token (iamcredentials). Google trusts only the Vercel project and
 * environment its pool allows; the account keeps only the Document AI role.
 */
function federatedTokens(f: Federation): TokenSource {
  return async () => {
    // Loaded only here: background jobs (broker) never need Vercel's library.
    const { getVercelOidcToken } = await import("@vercel/oidc");
    const subject = await getVercelOidcToken().catch(() => {
      throw rejected("oidc", 0);
    });
    const sts = await postJson("https://sts.googleapis.com/v1/token", {
      grantType: "urn:ietf:params:oauth:grant-type:token-exchange",
      audience: `//iam.googleapis.com/projects/${f.projectNumber}/locations/global/workloadIdentityPools/${f.pool}/providers/${f.provider}`,
      scope: SCOPE,
      requestedTokenType: "urn:ietf:params:oauth:token-type:access_token",
      subjectTokenType: "urn:ietf:params:oauth:token-type:jwt",
      subjectToken: subject,
    });
    if (!sts.ok) throw rejected("sts", sts.status);
    const federated = ((await sts.json()) as { access_token: string }).access_token;
    const res = await postJson(
      `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(f.serviceAccount)}:generateAccessToken`,
      { scope: [SCOPE], lifetime: "3600s" },
      federated,
    );
    if (!res.ok) throw rejected("impersonation", res.status);
    const body = (await res.json()) as { accessToken: string; expireTime: string };
    return { value: body.accessToken, expires: Date.parse(body.expireTime) };
  };
}

// ── Broker: background jobs get the one-hour token from ELISE on Vercel ─────────────────────

/** Requests older than this (or from the future) are refused, so a captured one soon expires. */
const BROKER_WINDOW_MS = 60_000;

/**
 * Signed with a secret of its own (OCR_BROKER_SECRET, in Vercel and Trigger.dev): rotating it
 * touches nothing else, and nothing else's rotation breaks OCR. The key is derived for this one
 * purpose, so a signature can't be reused anywhere else.
 */
const brokerSignature = (secret: string, at: string) => {
  const key = createHmac("sha256", secret).update("elise:ocr-token-broker:v1").digest();
  return createHmac("sha256", key).update(at).digest("base64url");
};

export function signBrokerRequest(secret: string, now = Date.now()) {
  const at = String(now);
  return { "x-elise-at": at, "x-elise-signature": brokerSignature(secret, at) };
}

export function verifyBrokerRequest(
  secret: string,
  at: string | null,
  signature: string | null,
  now = Date.now(),
): boolean {
  if (!at || !signature || !/^\d{1,15}$/.test(at)) return false;
  if (Math.abs(now - Number(at)) > BROKER_WINDOW_MS) return false;
  const expected = Buffer.from(brokerSignature(secret, at));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

function brokeredTokens(url: string, secret: string): TokenSource {
  return async () => {
    const res = await fetch(url, {
      method: "POST",
      headers: signBrokerRequest(secret),
      signal: AbortSignal.timeout(20_000),
    }).catch(() => {
      throw new AppError("PROVIDER_UNAVAILABLE", "The OCR token broker couldn't be reached", {
        recovery: "retry",
      });
    });
    if (!res.ok) throw rejected("broker", res.status);
    const body = (await res.json()) as { accessToken: string; expiresAt: number };
    return { value: body.accessToken, expires: body.expiresAt };
  };
}

/** One token at a time, reused until a minute before it expires. */
function cached(source: TokenSource): () => Promise<string> {
  let token: Token | null = null;
  return async () => {
    if (!token || token.expires <= Date.now() + 60_000) token = await source();
    return token.value;
  };
}

/**
 * Vercel hands its OIDC token only to its own functions (and locally after `vercel env pull`).
 * Anywhere else — Trigger.dev, even if the GCP_* identifiers were synced there — federation
 * can't work, so the broker is used instead.
 */
const vercelIdentity = () => process.env.VERCEL === "1" || Boolean(process.env.VERCEL_OIDC_TOKEN);

function federation(): Federation | null {
  const env = serverEnv();
  if (
    !vercelIdentity() ||
    !env.GCP_PROJECT_NUMBER ||
    !env.GCP_WORKLOAD_IDENTITY_POOL_ID ||
    !env.GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID ||
    !env.GCP_SERVICE_ACCOUNT_EMAIL
  )
    return null;
  return {
    projectNumber: env.GCP_PROJECT_NUMBER,
    pool: env.GCP_WORKLOAD_IDENTITY_POOL_ID,
    provider: env.GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID,
    serviceAccount: env.GCP_SERVICE_ACCOUNT_EMAIL,
  };
}

let current: { mode: string; token: () => Promise<string> } | null = null;

/** The configured way to get a token (see above), or null when none is configured. */
function tokenSource(): (() => Promise<string>) | null {
  const env = serverEnv();
  const f = federation();
  const json = env.GOOGLE_SERVICE_ACCOUNT_JSON;
  const broker = env.OCR_TOKEN_BROKER_URL;
  const secret = env.OCR_BROKER_SECRET;
  const pick = json
    ? { mode: "key", make: () => keyTokens(account(json)) }
    : f
      ? { mode: "federation", make: () => federatedTokens(f) }
      : broker && secret
        ? { mode: "broker", make: () => brokeredTokens(broker, secret) }
        : null;
  if (!pick) return null;
  if (current?.mode !== pick.mode) current = { mode: pick.mode, token: cached(pick.make()) };
  return current.token;
}

let brokered: Token | null = null;

/**
 * The broker's side (Vercel only): the one-hour token through federation, for a background job
 * that proved it holds the broker secret. Reused while it has 10 minutes left, so jobs always get
 * a useful token and Google isn't asked on every request. Null when federation isn't set here.
 */
export async function brokerToken(): Promise<{ accessToken: string; expiresAt: number } | null> {
  const f = federation();
  if (!f) return null;
  if (!brokered || brokered.expires <= Date.now() + 10 * 60_000)
    brokered = await federatedTokens(f)();
  return { accessToken: brokered.value, expiresAt: brokered.expires };
}

/** How OCR authenticates here (health and diagnostics; never a value). */
export function ocrAuthMode(): "key" | "federation" | "broker" | null {
  const env = serverEnv();
  if (!env.GOOGLE_DOCUMENT_AI_PROCESSOR) return null;
  if (env.GOOGLE_SERVICE_ACCOUNT_JSON) return "key";
  if (federation()) return "federation";
  return env.OCR_TOKEN_BROKER_URL && env.OCR_BROKER_SECRET ? "broker" : null;
}

interface DocAiPage {
  pageNumber?: number;
  layout?: { textAnchor?: { textSegments?: { startIndex?: string; endIndex?: string }[] } };
}

/** A page's text from the document text and its layout anchors (indexes are int64 strings). */
export function pagesFromDocument(doc: { text?: string; pages?: DocAiPage[] }) {
  const text = doc.text ?? "";
  return (doc.pages ?? []).map((p, i) => ({
    page: p.pageNumber ?? i + 1,
    text: (p.layout?.textAnchor?.textSegments ?? [])
      .map((s) => text.slice(Number(s.startIndex ?? 0), Number(s.endIndex ?? 0)))
      .join(""),
  }));
}

export class GoogleDocumentAiOcr implements OcrProvider {
  readonly id = "google_document_ai";
  constructor(
    private readonly processor: string,
    private readonly token: () => Promise<string>,
  ) {}

  async ocr(input: {
    data: Uint8Array;
    mimeType: string;
    pages: number[] | null;
    languageHints?: string[];
  }): Promise<{ page: number; text: string }[]> {
    const location = /locations\/([^/]+)/.exec(this.processor)![1]!;
    const started = Date.now();
    const res = await fetch(
      `https://${location}-documentai.googleapis.com/v1/${this.processor}:process`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${await this.token()}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          rawDocument: {
            content: Buffer.from(input.data).toString("base64"),
            mimeType: input.mimeType,
          },
          processOptions: {
            ...(input.pages ? { individualPageSelector: { pages: input.pages } } : {}),
            ocrConfig: input.languageHints?.length
              ? { hints: { languageHints: input.languageHints } }
              : {},
          },
          fieldMask: "text,pages.pageNumber,pages.layout.textAnchor",
        }),
        signal: AbortSignal.timeout(120_000),
      },
    );
    if (!res.ok) {
      const status = res.status;
      logger.warn("ocr.request_failed", { provider: this.id, status });
      throw new AppError(
        status === 429
          ? "RATE_LIMITED"
          : status === 401 || status === 403
            ? "AI_NOT_CONFIGURED"
            : "PROVIDER_UNAVAILABLE",
        status === 400
          ? "The OCR service couldn't read this file"
          : "The OCR service is unavailable",
        { details: { status }, ...(status === 400 ? { recovery: "review" as const } : {}) },
      );
    }
    const body = (await res.json()) as { document?: { text?: string; pages?: DocAiPage[] } };
    const pages = pagesFromDocument(body.document ?? {});
    recordUsage({
      operation: "ocr",
      provider: "google",
      model: "document-ai-ocr",
      units: pages.length,
      unit: "pages",
      latencyMs: Date.now() - started,
      status: "succeeded",
    });
    return pages;
  }
}

/** The configured OCR engine, or null: scanned pages are then reported, not guessed. */
export function getOcrProvider(): OcrProvider | null {
  const env = serverEnv();
  if (!env.GOOGLE_DOCUMENT_AI_PROCESSOR) return null;
  const token = tokenSource();
  return token ? new GoogleDocumentAiOcr(env.GOOGLE_DOCUMENT_AI_PROCESSOR, token) : null;
}

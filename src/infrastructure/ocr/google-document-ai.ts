import "server-only";

import { createSign } from "node:crypto";

import { serverEnv } from "@/config/server-env";
import { AppError } from "@/core/errors";
import type { OcrProvider } from "@/core/knowledge/extraction";
import { logger } from "@/infrastructure/observability/logger";
import { recordUsage } from "@/infrastructure/observability/usage";

/**
 * Google Document AI, Enterprise Document OCR (ADR-035). Online processing: up to 15 pages per
 * request (individual pages selected, so a mixed PDF only sends the scanned ones), up to 40 MB.
 * Authenticated as a service account (an OAuth token from a signed JWT; Document AI doesn't take
 * API keys). Server only: the key never reaches the browser.
 */

interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

function account(raw: string): ServiceAccount {
  const text = raw.trim().startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8");
  const parsed = JSON.parse(text) as ServiceAccount;
  if (!parsed.client_email || !parsed.private_key)
    throw new AppError("AI_NOT_CONFIGURED", "The OCR service account key is incomplete");
  return parsed;
}

const b64url = (s: string | Buffer) => Buffer.from(s).toString("base64url");

let token: { value: string; expires: number } | null = null;

async function accessToken(sa: ServiceAccount): Promise<string> {
  if (token && token.expires > Date.now() + 60_000) return token.value;
  const now = Math.floor(Date.now() / 1000);
  const uri = sa.token_uri ?? "https://oauth2.googleapis.com/token";
  const unsigned = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: "https://www.googleapis.com/auth/cloud-platform",
      aud: uri,
      iat: now,
      exp: now + 3600,
    }),
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
  if (!res.ok)
    throw new AppError("AI_NOT_CONFIGURED", "Google rejected the OCR service account", {
      recovery: "configure",
      details: { status: res.status },
    });
  const body = (await res.json()) as { access_token: string; expires_in: number };
  token = { value: body.access_token, expires: Date.now() + body.expires_in * 1000 };
  return token.value;
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
    private readonly sa: ServiceAccount,
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
          authorization: `Bearer ${await accessToken(this.sa)}`,
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
  if (!env.GOOGLE_DOCUMENT_AI_PROCESSOR || !env.GOOGLE_SERVICE_ACCOUNT_JSON) return null;
  return new GoogleDocumentAiOcr(
    env.GOOGLE_DOCUMENT_AI_PROCESSOR,
    account(env.GOOGLE_SERVICE_ACCOUNT_JSON),
  );
}

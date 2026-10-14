import { AppError } from "@/core/errors";

import type { FetchLike } from "../google/oauth";

/**
 * Graph allows 4 concurrent requests per app per mailbox; more only earns 429s. One client per
 * connection, so this is per mailbox.
 */
const MAX_CONCURRENT = 4;
const MAX_RETRIES = 2;
/** Longer waits than this are reported as "busy, try shortly" instead of holding the request. */
const MAX_WAIT_MS = 8_000;

interface GraphErrorBody {
  error?: { code?: string; message?: string };
}

/**
 * Authenticated JSON client for Microsoft Graph. Retries once with a fresh token on 401, honours
 * Retry-After with bounded backoff on throttling, and keeps concurrency under Graph's mailbox
 * limit. Translates Graph errors into ELISE errors; raw provider messages never leave this file.
 * Throttling is RATE_LIMITED — never a reason to mark the account disconnected.
 */
export class GraphHttp {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(
    private readonly tokens: { accessToken(forceRefresh?: boolean): Promise<string> },
    private readonly options: {
      fetchImpl?: FetchLike;
      sleep?: (ms: number) => Promise<void>;
      /** Called when Graph still rejects a freshly refreshed token (revoked, policy). */
      onUnauthorized?: (reason: string) => Promise<void>;
    } = {},
  ) {}

  async request<T>(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    url: string,
    body?: unknown,
    opts: { notFoundAsNull?: boolean; headers?: Record<string, string> } = {},
  ): Promise<T | null> {
    await this.acquire();
    try {
      let forceRefresh = false;
      for (let attempt = 0; ; attempt++) {
        const res = await this.send(method, url, body, forceRefresh, opts.headers);
        if (res.status === 401 && !forceRefresh) {
          forceRefresh = true;
          continue;
        }
        if (res.ok) {
          if (res.status === 202 || res.status === 204) return null;
          const text = await res.text();
          return text ? (JSON.parse(text) as T) : null;
        }
        if ((res.status === 404 || res.status === 410) && opts.notFoundAsNull) return null;
        // 429 means "not processed": safe to retry for writes too. 503/504 only for reads.
        const retryable =
          res.status === 429 || (method === "GET" && [503, 504].includes(res.status));
        const wait = retryDelay(res, attempt);
        if (retryable && attempt < MAX_RETRIES && wait <= MAX_WAIT_MS) {
          await (this.options.sleep ?? defaultSleep)(wait);
          continue;
        }
        const error = await toAppError(res, method);
        if (error.code === "AUTH_EXPIRED")
          await this.options.onUnauthorized?.(String(error.details?.reason ?? "unauthorized"));
        throw error;
      }
    } finally {
      this.release();
    }
  }

  private async send(
    method: string,
    url: string,
    body: unknown,
    forceRefresh: boolean,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    const token = await this.tokens.accessToken(forceRefresh);
    try {
      return await (this.options.fetchImpl ?? fetch)(url, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
          ...headers,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(20_000),
      });
    } catch (cause) {
      // A write that timed out may or may not have happened: never report success or retry blindly.
      if (method !== "GET")
        throw new AppError("UNKNOWN_OUTCOME", "Microsoft did not confirm the change in time", {
          cause,
          recovery: "review",
        });
      throw new AppError("PROVIDER_UNAVAILABLE", "Microsoft did not respond", { cause });
    }
  }

  private async acquire() {
    if (this.active < MAX_CONCURRENT) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
  }

  private release() {
    const next = this.waiting.shift();
    // The slot passes straight to the next waiter.
    if (next) next();
    else this.active--;
  }
}

function defaultSleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/** Retry-After (seconds) when Graph sends it; otherwise exponential backoff from 500 ms. */
export function retryDelay(res: Response, attempt: number): number {
  const raw = res.headers.get("retry-after");
  const header = raw === null || raw.trim() === "" ? NaN : Number(raw);
  if (Number.isFinite(header) && header >= 0) return header * 1000;
  return 500 * 2 ** attempt;
}

async function toAppError(res: Response, method: string): Promise<AppError> {
  const body = (await res.json().catch(() => ({}))) as GraphErrorBody;
  const code = body.error?.code ?? "";
  const details = { providerStatus: res.status, providerReason: code, method };
  if (res.status === 401) {
    // A Conditional Access claims challenge also arrives as 401 (insufficient_claims).
    const policy = /insufficient_claims/i.test(res.headers.get("www-authenticate") ?? "");
    return new AppError("AUTH_EXPIRED", "This Microsoft account needs to be reconnected", {
      recovery: "reconnect",
      details: { ...details, reason: policy ? "conditional_access" : "unauthorized" },
    });
  }
  if (
    /MailboxNotEnabledForRESTAPI|MailboxNotSupportedForRESTAPI|ResourceNotFound.*mailbox/i.test(
      code,
    )
  )
    return new AppError(
      "CAPABILITY_UNAVAILABLE",
      "This Microsoft account has no Outlook mailbox ELISE can reach",
      { recovery: "review", details },
    );
  if (res.status === 429 || /ApplicationThrottled|ErrorServerBusy|TooManyRequests/i.test(code))
    return new AppError(
      "RATE_LIMITED",
      "Microsoft is limiting requests right now. Try again shortly.",
      { details },
    );
  if (res.status === 403)
    return new AppError("PERMISSION_DENIED", "ELISE doesn't have permission for this in Outlook", {
      recovery: "reconnect",
      details,
    });
  if (res.status === 404 || res.status === 410 || /ErrorItemNotFound/i.test(code))
    return new AppError("NOT_FOUND", "That item no longer exists in Outlook", { details });
  if (res.status === 409 || res.status === 412)
    return new AppError("CONFLICT", "That changed in Outlook meanwhile", { details });
  if (res.status === 400)
    return new AppError("VALIDATION_ERROR", "Outlook rejected the request", {
      recovery: "review",
      details,
    });
  // A server error on a write (e.g. sending) may or may not have been applied.
  if (res.status >= 500 && method !== "GET")
    return new AppError("UNKNOWN_OUTCOME", "Microsoft did not confirm the change", {
      recovery: "review",
      details,
    });
  return new AppError("PROVIDER_UNAVAILABLE", "Microsoft is temporarily unavailable", { details });
}

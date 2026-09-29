import { AppError } from "@/core/errors";

import type { GoogleTokenProvider } from "./credentials";
import type { FetchLike } from "./oauth";

interface GoogleErrorBody {
  error?: { code?: number; message?: string; status?: string; errors?: { reason?: string }[] };
}

/**
 * Authenticated JSON client for Google APIs. Retries once with a fresh token on 401 (a 401 means
 * the request was not processed, so it is safe for writes too). Translates Google errors into
 * ELISE errors; raw provider messages never leave this file.
 */
export class GoogleHttp {
  constructor(
    private readonly tokens: Pick<GoogleTokenProvider, "accessToken">,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async request<T>(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    url: string,
    body?: unknown,
    options: { notFoundAsNull?: boolean } = {},
  ): Promise<T | null> {
    let res = await this.send(method, url, body, false);
    if (res.status === 401) res = await this.send(method, url, body, true);
    if (res.ok) {
      if (res.status === 204) return null;
      const text = await res.text();
      return text ? (JSON.parse(text) as T) : null;
    }
    if ((res.status === 404 || res.status === 410) && options.notFoundAsNull) return null;
    throw await toAppError(res, method);
  }

  private async send(
    method: string,
    url: string,
    body: unknown,
    forceRefresh: boolean,
  ): Promise<Response> {
    const token = await this.tokens.accessToken(forceRefresh);
    try {
      return await this.fetchImpl(url, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15_000),
      });
    } catch (cause) {
      // A write that timed out may or may not have happened: never report success or retry blindly.
      if (method !== "GET") {
        throw new AppError("UNKNOWN_OUTCOME", "Google did not confirm the change in time", {
          cause,
          recovery: "review",
        });
      }
      throw new AppError("PROVIDER_UNAVAILABLE", "Google did not respond", { cause });
    }
  }
}

async function toAppError(res: Response, method: string): Promise<AppError> {
  const body = (await res.json().catch(() => ({}))) as GoogleErrorBody;
  const reason = body.error?.errors?.[0]?.reason ?? body.error?.status ?? "";
  const details = { providerStatus: res.status, providerReason: reason, method };
  if (res.status === 401) {
    return new AppError("AUTH_EXPIRED", "This Google account needs to be reconnected", {
      recovery: "reconnect",
      details,
    });
  }
  if (res.status === 403 && /insufficient|scope|PERMISSION_DENIED|forbidden/i.test(reason)) {
    return new AppError(
      "PERMISSION_DENIED",
      "ELISE doesn't have permission for this in Google yet",
      {
        recovery: "reconnect",
        details,
      },
    );
  }
  if (res.status === 429 || /rateLimit|userRateLimit|quota/i.test(reason)) {
    return new AppError(
      "RATE_LIMITED",
      "Google is limiting requests right now. Try again shortly.",
      { details },
    );
  }
  if (res.status === 404 || res.status === 410)
    return new AppError("NOT_FOUND", "That item no longer exists in Google", { details });
  if (res.status === 409 || res.status === 412)
    return new AppError("CONFLICT", "That changed in Google meanwhile", { details });
  if (res.status === 400)
    return new AppError("VALIDATION_ERROR", "Google rejected the request", {
      recovery: "review",
      details,
    });
  if (res.status === 403)
    return new AppError("PERMISSION_DENIED", "Google denied the request", { details });
  return new AppError("PROVIDER_UNAVAILABLE", "Google is temporarily unavailable", { details });
}

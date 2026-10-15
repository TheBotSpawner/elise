import { AppError } from "@/core/errors";

import { SLACK_API } from "./oauth";
import type { FetchLike } from "../google/oauth";

const MAX_RETRIES = 2;
/** Waits longer than this are reported as "busy, try shortly" instead of holding the request. */
const MAX_WAIT_MS = 8_000;

/** Methods that change something in Slack: a failure after sending may still have happened. */
const WRITES = new Set([
  "chat.postMessage",
  "reactions.add",
  "reactions.remove",
  "conversations.open",
]);

const REVOKED = new Set([
  "invalid_auth",
  "token_revoked",
  "account_inactive",
  "not_authed",
  "no_permission_for_token",
]);
const NOT_FOUND = new Set([
  "channel_not_found",
  "thread_not_found",
  "message_not_found",
  "user_not_found",
  "users_not_found",
  "file_not_found",
  "context_channel_not_found",
]);
const NOT_ALLOWED = new Set([
  "not_in_channel",
  "is_archived",
  "restricted_action",
  "restricted_action_read_only_channel",
  "restricted_action_thread_only_channel",
  "restricted_action_non_threadable_channel",
  "access_denied",
  "no_permission",
  "team_access_not_granted",
  "ekm_access_denied",
  "cannot_dm_bot",
  "user_disabled",
  "channel_is_archived",
]);
/** Real-time Search isn't available to this app or workspace (unlisted app, plan, migration). */
const SEARCH_UNAVAILABLE = new Set([
  "feature_not_enabled",
  "assistant_search_context_disabled",
  "not_allowed_token_type",
  "enterprise_is_restricted",
  "method_deprecated",
  "deprecated_endpoint",
]);
const BUSY = new Set(["ratelimited", "rate_limited"]);
const SERVER = new Set(["fatal_error", "internal_error", "service_unavailable", "request_timeout"]);

export interface SlackCallLog {
  method: string;
  attempts: number;
  latencyMs: number;
  rateLimited: boolean;
  ok: boolean;
  error: string | null;
}

/**
 * Authenticated Slack Web API client for one connection. Honours Retry-After (with jitter) on
 * rate limits, refreshes a rotated token once when Slack says it expired, and turns Slack's
 * error strings into ELISE errors; raw provider text never leaves this file. Logs method,
 * attempts, latency and rate-limit state — never arguments or content.
 */
export class SlackHttp {
  constructor(
    private readonly tokens: { accessToken(forceRefresh?: boolean): Promise<string> },
    private readonly options: {
      fetchImpl?: FetchLike;
      sleep?: (ms: number) => Promise<void>;
      random?: () => number;
      /** Slack rejected the grant itself (revoked, account removed): mark the connection. */
      onUnauthorized?: (reason: string) => Promise<void>;
      log?: (entry: SlackCallLog) => void;
    } = {},
  ) {}

  async call<T>(
    method: string,
    args: Record<string, string | number | boolean | string[] | undefined>,
    opts: { json?: boolean } = {},
  ): Promise<T> {
    const started = Date.now();
    let attempts = 0;
    let rateLimited = false;
    let refreshed = false;
    const done = (ok: boolean, error: string | null) =>
      this.options.log?.({
        method,
        attempts,
        latencyMs: Date.now() - started,
        rateLimited,
        ok,
        error,
      });
    const write = WRITES.has(method);
    for (;;) {
      attempts++;
      let res: Response;
      try {
        res = await this.send(method, args, Boolean(opts.json), refreshed);
      } catch (cause) {
        done(false, "network");
        // A write that timed out may or may not have happened: never retry or claim it blindly.
        if (write)
          throw new AppError("UNKNOWN_OUTCOME", "Slack did not confirm the change in time", {
            cause,
            recovery: "review",
          });
        throw new AppError("PROVIDER_UNAVAILABLE", "Slack did not respond", { cause });
      }
      if (res.status === 429) {
        rateLimited = true;
        const wait = retryDelay(res, attempts - 1, this.options.random ?? Math.random);
        // 429 means "not processed": safe to retry, writes included.
        if (attempts <= MAX_RETRIES && wait <= MAX_WAIT_MS) {
          await (this.options.sleep ?? defaultSleep)(wait);
          continue;
        }
        done(false, "rate_limited");
        const told = Number(res.headers.get("retry-after"));
        throw new AppError(
          "RATE_LIMITED",
          "Slack is limiting requests right now. Try again shortly.",
          {
            details: { method, retryAfterSeconds: told > 0 ? told : Math.ceil(wait / 1000) },
          },
        );
      }
      if (res.status >= 500) {
        done(false, `http_${res.status}`);
        throw write
          ? new AppError("UNKNOWN_OUTCOME", "Slack did not confirm the change", {
              recovery: "review",
            })
          : new AppError("PROVIDER_UNAVAILABLE", "Slack is temporarily unavailable", {
              details: { providerStatus: res.status },
            });
      }
      const body = (await res.json().catch(() => ({ ok: false, error: "invalid_response" }))) as {
        ok: boolean;
        error?: string;
        needed?: string;
      } & T;
      if (body.ok) {
        done(true, null);
        return body;
      }
      const code = body.error ?? "unknown";
      // A rotated token expired between our check and Slack's: refresh once, then retry.
      if (code === "token_expired" && !refreshed) {
        refreshed = true;
        continue;
      }
      done(false, code);
      const error = slackError(code, method, write, body.needed ?? null);
      if (error.code === "AUTH_EXPIRED") await this.options.onUnauthorized?.(code);
      throw error;
    }
  }

  private async send(
    method: string,
    args: Record<string, string | number | boolean | string[] | undefined>,
    json: boolean,
    forceRefresh: boolean,
  ): Promise<Response> {
    const token = await this.tokens.accessToken(forceRefresh);
    const defined = Object.entries(args).filter(([, v]) => v !== undefined);
    const body = json
      ? JSON.stringify(Object.fromEntries(defined))
      : new URLSearchParams(
          defined.map(([k, v]) => [k, Array.isArray(v) ? v.join(",") : String(v)]),
        ).toString();
    return (this.options.fetchImpl ?? fetch)(`${SLACK_API}/${method}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": json
          ? "application/json; charset=utf-8"
          : "application/x-www-form-urlencoded",
      },
      body,
      signal: AbortSignal.timeout(20_000),
    });
  }
}

function defaultSleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/** Retry-After seconds (plus up to 20% jitter); otherwise exponential backoff from 500 ms. */
export function retryDelay(
  res: Response,
  attempt: number,
  random: () => number = Math.random,
): number {
  const raw = res.headers.get("retry-after");
  const header = raw === null || raw.trim() === "" ? NaN : Number(raw);
  const base = Number.isFinite(header) && header >= 0 ? header * 1000 : 500 * 2 ** attempt;
  return Math.round(base * (1 + random() * 0.2));
}

/** One Slack error string → the ELISE error the product knows how to explain. */
export function slackError(
  code: string,
  method: string,
  write: boolean,
  needed: string | null,
): AppError {
  const details = { providerReason: code, method };
  if (REVOKED.has(code) || code === "token_expired")
    return new AppError("AUTH_EXPIRED", "This Slack workspace needs to be reconnected", {
      recovery: "reconnect",
      details: { ...details, reason: code },
    });
  if (code === "missing_scope")
    // A permission the user hasn't given ELISE: never "disconnected", never marks the connection.
    return new AppError(
      "PERMISSION_DENIED",
      "ELISE isn't allowed to do that in this Slack workspace yet",
      {
        recovery: "reconnect",
        details: { ...details, reason: "missing_scope", needed },
      },
    );
  if (NOT_FOUND.has(code))
    return new AppError(
      "NOT_FOUND",
      "That conversation or message doesn't exist or isn't visible to you",
      {
        recovery: "review",
        details,
      },
    );
  if (NOT_ALLOWED.has(code))
    return new AppError("PERMISSION_DENIED", "Slack doesn't let you do that there", {
      recovery: "review",
      details: { ...details, reason: code },
    });
  if (SEARCH_UNAVAILABLE.has(code))
    return new AppError(
      "CAPABILITY_UNAVAILABLE",
      "Slack search isn't available for this workspace",
      {
        recovery: "review",
        details: { ...details, reason: "search_unavailable" },
      },
    );
  if (BUSY.has(code))
    return new AppError(
      "RATE_LIMITED",
      "Slack is limiting requests right now. Try again shortly.",
      { details },
    );
  if (SERVER.has(code))
    return write
      ? new AppError("UNKNOWN_OUTCOME", "Slack did not confirm the change", {
          recovery: "review",
          details,
        })
      : new AppError("PROVIDER_UNAVAILABLE", "Slack is temporarily unavailable", { details });
  if (
    /^invalid_|^missing_|_too_long$|^too_many/.test(code) ||
    code === "no_text" ||
    code === "msg_too_long"
  )
    return new AppError("VALIDATION_ERROR", "Slack rejected the request", {
      recovery: "review",
      details,
    });
  return new AppError("PROVIDER_UNAVAILABLE", "Slack rejected the request", { details });
}

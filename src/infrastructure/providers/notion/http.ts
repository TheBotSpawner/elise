import { AppError } from "@/core/errors";

/**
 * The one place ELISE talks HTTP to Notion (Knowledge and Structured Data share it).
 *
 * NOTION_VERSION is centralized here: 2026-03-11, the current version of the public API.
 * In it a database is a container of one or more data sources (queried at
 * /data_sources/{id}/query), pages are created under a `data_source_id` parent, and `in_trash`
 * replaces `archived` everywhere.
 */
export const NOTION_API = "https://api.notion.com/v1";
export const NOTION_VERSION = "2026-03-11";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

type Method = "GET" | "POST" | "PATCH";

/**
 * Notion allows about 3 requests per second per integration (ADR-048). Every request of one
 * connection (keyed by its token) goes through one gate: at most NOTION_LIMITS.concurrency in
 * flight and starts spaced by minIntervalMs — a turn can't fan out into a request storm, and
 * concurrent turns share the same budget.
 */
export const NOTION_LIMITS = {
  concurrency: 3,
  minIntervalMs: 340,
  /** Retries of one read after 429/529 (Retry-After when given, else 1 s, 2 s). */
  retries: 2,
  maxRetryAfterSeconds: 10,
} as const;

interface Gate {
  active: number;
  lastStart: number;
  queue: (() => void)[];
}
const gates = new Map<string, Gate>();
/** Identical reads already in flight are shared, never sent twice (per connection). */
const inFlight = new Map<string, Promise<unknown>>();

async function throttled<T>(key: string, run: () => Promise<T>): Promise<T> {
  const gate = gates.get(key) ?? { active: 0, lastStart: 0, queue: [] };
  gates.set(key, gate);
  if (gate.active >= NOTION_LIMITS.concurrency)
    await new Promise<void>((resolve) => gate.queue.push(resolve));
  gate.active++;
  const wait = gate.lastStart + NOTION_LIMITS.minIntervalMs - Date.now();
  gate.lastStart = Math.max(Date.now(), gate.lastStart + NOTION_LIMITS.minIntervalMs);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  try {
    return await run();
  } finally {
    gate.active--;
    gate.queue.shift()?.();
  }
}

/** Counters for one client's lifetime (one turn, one sync): what "why 28 calls?" needs. */
export interface NotionStats {
  requests: number;
  shared: number;
  retries: number;
  rateLimited: number;
}

export class NotionHttp {
  readonly stats: NotionStats = { requests: 0, shared: 0, retries: 0, rateLimited: 0 };

  constructor(
    private readonly token: () => Promise<string>,
    private readonly onUnauthorized: () => Promise<void>,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => setTimeout(r, ms)),
  ) {}

  /**
   * `read` marks requests that change nothing (GET, search, query): those retry a bounded number
   * of times after a rate limit, honoring Retry-After. Writes never retry on their own — the
   * outcome could be unknown. Identical reads in flight are shared.
   */
  async request<T>(
    method: Method,
    path: string,
    body?: unknown,
    read = method === "GET",
  ): Promise<T> {
    if (!read) return this.perform<T>(method, path, body, read);
    const token = await this.token();
    const key = `${token}|${method}|${path}|${body ? JSON.stringify(body) : ""}`;
    const pending = inFlight.get(key);
    if (pending) {
      this.stats.shared++;
      return pending as Promise<T>;
    }
    const p = this.perform<T>(method, path, body, read).finally(() => inFlight.delete(key));
    inFlight.set(key, p);
    return p;
  }

  private async perform<T>(method: Method, path: string, body: unknown, read: boolean): Promise<T> {
    let res: Response;
    try {
      res = await this.send(method, path, body);
    } catch (error) {
      // A write that timed out may have been saved in Notion.
      if (!read)
        throw new AppError(
          "UNKNOWN_OUTCOME",
          "Notion didn't confirm the change. Check it in Notion.",
          {
            cause: error,
            recovery: "review",
          },
        );
      throw error;
    }
    // A bounded retry budget for reads: Retry-After when Notion gives one, else 1 s then 2 s.
    for (let attempt = 1; (res.status === 429 || res.status === 529) && read; attempt++) {
      this.stats.rateLimited++;
      if (attempt > NOTION_LIMITS.retries) break;
      const header = Number(res.headers.get("retry-after"));
      const wait = Number.isFinite(header) && header > 0 ? header : 2 ** (attempt - 1);
      if (wait > NOTION_LIMITS.maxRetryAfterSeconds) break;
      await this.sleep(Math.max(wait, 0.5) * 1000);
      this.stats.retries++;
      res = await this.send(method, path, body);
    }
    if (res.ok) return (await res.json()) as T;
    const payload = (await res.json().catch(() => ({}))) as { code?: string; message?: string };
    const details = { providerStatus: res.status, providerCode: payload.code };
    if (res.status === 401) {
      await this.onUnauthorized();
      throw new AppError("AUTH_EXPIRED", "This Notion connection needs to be reconnected", {
        recovery: "reconnect",
        details,
      });
    }
    if (res.status === 403)
      throw new AppError(
        "PERMISSION_DENIED",
        "ELISE can't do this in Notion. Share the page or database with ELISE, and allow ELISE to insert and update content in its Notion connection.",
        { details, recovery: "reconnect" },
      );
    if (res.status === 404)
      throw new AppError("NOT_FOUND", "That page or database is no longer shared with ELISE", {
        details,
      });
    if (res.status === 409)
      throw new AppError("CONFLICT", "Notion changed this at the same time. Try again.", {
        details,
        recovery: "retry",
      });
    if (res.status === 429 || res.status === 529)
      throw new AppError("RATE_LIMITED", "Notion is limiting requests. Try again in a moment.", {
        details,
      });
    if (res.status >= 500) {
      // A failed write may still have been saved: never claim either way.
      if (!read)
        throw new AppError(
          "UNKNOWN_OUTCOME",
          "Notion didn't confirm the change. Check it in Notion.",
          {
            details,
            recovery: "review",
          },
        );
      throw new AppError("PROVIDER_UNAVAILABLE", "Notion is unavailable", { details });
    }
    // Notion explains validation errors ("Status is expected to be status.") — useful to fix input.
    throw new AppError(
      "VALIDATION_ERROR",
      `Notion rejected the request${payload.message ? `: ${payload.message.slice(0, 240)}` : ""}`,
      { details, recovery: "review" },
    );
  }

  private async send(method: Method, path: string, body?: unknown): Promise<Response> {
    const token = await this.token();
    this.stats.requests++;
    try {
      return await throttled(token, () =>
        this.fetchImpl(`${NOTION_API}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            "notion-version": NOTION_VERSION,
            ...(body ? { "content-type": "application/json" } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(20_000),
        }),
      );
    } catch (cause) {
      if (cause instanceof AppError) throw cause;
      throw new AppError("PROVIDER_UNAVAILABLE", "Notion did not respond", { cause });
    }
  }
}

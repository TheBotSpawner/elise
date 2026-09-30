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

export class NotionHttp {
  constructor(
    private readonly token: () => Promise<string>,
    private readonly onUnauthorized: () => Promise<void>,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  /**
   * `read` marks requests that change nothing (GET, search, query): those retry once after a
   * short rate limit. Writes never retry on their own — the outcome could be unknown.
   */
  async request<T>(
    method: Method,
    path: string,
    body?: unknown,
    read = method === "GET",
  ): Promise<T> {
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
    if ((res.status === 429 || res.status === 529) && read) {
      const wait = Number(res.headers.get("retry-after") ?? "1");
      if (Number.isFinite(wait) && wait <= 5) {
        await new Promise((r) => setTimeout(r, Math.max(wait, 0.5) * 1000));
        res = await this.send(method, path, body);
      }
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
    try {
      return await this.fetchImpl(`${NOTION_API}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${await this.token()}`,
          "notion-version": NOTION_VERSION,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(20_000),
      });
    } catch (cause) {
      if (cause instanceof AppError) throw cause;
      throw new AppError("PROVIDER_UNAVAILABLE", "Notion did not respond", { cause });
    }
  }
}

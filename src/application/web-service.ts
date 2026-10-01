import "server-only";

import { serverEnv } from "@/config/server-env";
import { AppError, toAppError } from "@/core/errors";
import {
  WEB_LIMITS,
  type WebCapability,
  type WebPage,
  type WebResult,
  type WebSearchProvider,
  type WebSearchQuery,
} from "@/core/web/model";
import { checkUrl, normalizeUrl } from "@/core/web/url";
import { logger } from "@/infrastructure/observability/logger";
import { createAdminClient } from "@/infrastructure/supabase/admin";
import { fetchPage } from "@/infrastructure/web/fetcher";
import {
  OpenAIWebSearch,
  TavilyWebSearch,
  type SearchUsage,
} from "@/infrastructure/web/search-providers";

import type { AuthContext } from "./auth-context";
import { listSpaces, saveWebPageToKnowledge } from "./knowledge-service";

/**
 * The Web capability for one request (ADR-015): provider choice, timeouts, a short cache,
 * per-workspace daily limits and usage metrics. Queries and page text are never logged.
 */

export function webSearchConfigured(): boolean {
  const env = serverEnv();
  return Boolean(env.TAVILY_API_KEY || env.OPENAI_API_KEY);
}

function provider(onUsage: (u: SearchUsage) => void): WebSearchProvider {
  const env = serverEnv();
  const choice = env.WEB_SEARCH_PROVIDER ?? (env.TAVILY_API_KEY ? "tavily" : "openai");
  if (choice === "tavily" && env.TAVILY_API_KEY)
    return new TavilyWebSearch(env.TAVILY_API_KEY, onUsage);
  if (choice === "openai" && env.OPENAI_API_KEY)
    return new OpenAIWebSearch(env.OPENAI_API_KEY, env.OPENAI_WEB_SEARCH_MODEL, onUsage);
  throw new AppError("CAPABILITY_UNAVAILABLE", "Web search isn't configured", {
    recovery: "configure",
  });
}

// ponytail: per-instance cache (short TTLs); a shared cache only if hit rates justify it.
const cache = new Map<string, { at: number; ttl: number; value: unknown }>();
function cached<T>(key: string): T | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > hit.ttl) {
    cache.delete(key);
    return null;
  }
  return hit.value as T;
}
function remember(key: string, value: unknown, ttl: number) {
  if (cache.size > 400) cache.delete(cache.keys().next().value!);
  cache.set(key, { at: Date.now(), ttl, value });
}

/** Counts usage against the workspace's daily limits; fails open if the counter is unavailable. */
async function consume(auth: AuthContext, kind: "searches" | "fetches") {
  const { data, error } = await createAdminClient().rpc("record_web_usage", {
    p_workspace_id: auth.workspaceId,
    p_searches: kind === "searches" ? 1 : 0,
    p_fetches: kind === "fetches" ? 1 : 0,
  });
  if (error) {
    logger.warn("web.usage_unavailable", { code: error.code });
    return;
  }
  const row = Array.isArray(data) ? data[0] : data;
  const limit = kind === "searches" ? WEB_LIMITS.dailySearches : WEB_LIMITS.dailyFetches;
  if ((row?.[kind] ?? 0) > limit)
    throw new AppError(
      "RATE_LIMITED",
      "The daily web research limit for this workspace was reached.",
    );
}

export function webCapability(auth: AuthContext, runId: string | null = null): WebCapability {
  const log = { workspace_id: auth.workspaceId, run_id: runId };
  const onUsage = (u: SearchUsage) => logger.info("web.usage", { ...log, ...u });
  return {
    async search(q: WebSearchQuery): Promise<WebResult[]> {
      const key = `${auth.workspaceId}:s:${q.kind}:${q.recency}:${q.domains?.join(",")}:${q.query.toLowerCase()}`;
      const hit = cached<WebResult[]>(key);
      if (hit) {
        logger.info("web.searched", { ...log, kind: q.kind, results: hit.length, cached: true });
        return hit;
      }
      await consume(auth, "searches");
      const started = Date.now();
      const p = provider(onUsage);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), WEB_LIMITS.searchTimeoutMs);
      try {
        const results = await p.search(q, controller.signal);
        logger.info("web.searched", {
          ...log,
          provider: p.id,
          kind: q.kind,
          recency: q.recency,
          results: results.length,
          latency_ms: Date.now() - started,
        });
        remember(
          key,
          results,
          q.kind === "news" ? WEB_LIMITS.cacheNewsMs : WEB_LIMITS.cacheSearchMs,
        );
        return results;
      } catch (error) {
        const code = controller.signal.aborted ? "TIMEOUT" : toAppError(error).code;
        logger.warn("web.search_failed", {
          ...log,
          provider: p.id,
          code,
          latency_ms: Date.now() - started,
        });
        if (controller.signal.aborted)
          throw new AppError("PROVIDER_UNAVAILABLE", "Web search took too long", {
            recovery: "retry",
          });
        throw error;
      } finally {
        clearTimeout(timer);
      }
    },

    async open(url: string): Promise<WebPage> {
      const check = checkUrl(url);
      if (!check.ok)
        throw new AppError("VALIDATION_ERROR", `Blocked link: ${check.reason}`, {
          recovery: "review",
        });
      const key = `${auth.workspaceId}:p:${normalizeUrl(url)}`;
      const hit = cached<WebPage>(key);
      if (hit) return { ...hit, requestedUrl: url };
      await consume(auth, "fetches");
      const started = Date.now();
      try {
        const page = await fetchPage(check.url.toString());
        logger.info("web.fetched", {
          ...log,
          domain: page.domain,
          chars: page.text.length,
          truncated: page.truncated,
          latency_ms: Date.now() - started,
        });
        remember(key, page, WEB_LIMITS.cachePageMs);
        return { ...page, requestedUrl: url };
      } catch (error) {
        logger.info("web.fetch_failed", {
          ...log,
          code: toAppError(error).code,
          latency_ms: Date.now() - started,
        });
        throw error;
      }
    },

    async saveToKnowledge(page, space) {
      const spaces = await listSpaces(auth);
      const wanted = space?.trim().toLowerCase();
      const match = wanted
        ? spaces.filter(
            (s) =>
              s.id === space || s.name.toLowerCase() === wanted || s.path.toLowerCase() === wanted,
          )
        : spaces.length === 1
          ? spaces
          : [];
      if (match.length !== 1)
        throw new AppError(
          "VALIDATION_ERROR",
          spaces.length
            ? `Which Knowledge Space? ${spaces.map((s) => s.path).join("; ")}`
            : "There are no Knowledge Spaces yet: create one first.",
          { recovery: "review" },
        );
      const { itemId } = await saveWebPageToKnowledge(auth, match[0]!.id, page);
      logger.info("web.saved_to_knowledge", { ...log, domain: page.domain });
      return { itemId, space: match[0]!.path };
    },
  };
}

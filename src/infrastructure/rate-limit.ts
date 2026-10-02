import "server-only";

import { AppError } from "@/core/errors";

const hits = new Map<string, number[]>();

/**
 * Sliding-window limit per key (usually `${operation}:${userId}`). Protects expensive routes
 * (voice, research, ingestion, study) from runaway loops, not from determined abuse.
 * ponytail: per-instance memory; move to a shared store (Postgres/Redis) if abuse across
 * serverless instances matters.
 */
export function rateLimit(
  key: string,
  max: number,
  windowMs: number,
  message = "Too many requests. Wait a moment and try again.",
): void {
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= max) throw new AppError("RATE_LIMITED", message);
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > 10_000) {
    for (const [k, times] of hits) if (!times.some((t) => now - t < windowMs)) hits.delete(k);
  }
}

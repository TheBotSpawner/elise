import "server-only";

import {
  fold,
  type Chain,
  type HistoryPoint,
  type Product,
  type Region,
  type ShoppingData,
  type SizeUnit,
} from "@/core/shopping/model";
import { logger } from "@/infrastructure/observability/logger";
import { createAdminClient } from "@/infrastructure/supabase/admin";

import { decodeSnapshot, pricesOf, snapshotPath, type Snapshot } from "./snapshot";

/**
 * ELISE's copy of SEPA's public data (ADR-111): the catalog and the price history in Postgres,
 * each province's prices of the day in Storage. Public data only — nothing here knows a user —
 * so it's read with the service role and shared by every workspace.
 */

export const SHOPPING_BUCKET = "shopping-prices";

/** A province's snapshot is re-read at most this often per server instance. */
const SNAPSHOT_TTL_MS = 30 * 60_000;
// ponytail: per-instance cache (~24 × ≤10 MB parsed); a shared cache only if instances multiply.
const snapshots = new Map<Region, { at: number; snap: Snapshot | null }>();
const inflight = new Map<Region, Promise<Snapshot | null>>();

async function snapshot(region: Region): Promise<Snapshot | null> {
  const hit = snapshots.get(region);
  if (hit && Date.now() - hit.at < SNAPSHOT_TTL_MS) return hit.snap;
  let pending = inflight.get(region);
  if (!pending) {
    const started = Date.now();
    pending = (async () => {
      const { data, error } = await createAdminClient()
        .storage.from(SHOPPING_BUCKET)
        .download(snapshotPath(region));
      if (error || !data) {
        logger.info("shopping_snapshot_read", { region, status: "missing" });
        return null;
      }
      const snap = decodeSnapshot(new Uint8Array(await data.arrayBuffer()));
      logger.info("shopping_snapshot_read", {
        region,
        status: "success",
        date: snap.date,
        latency_ms: Date.now() - started,
      });
      return snap;
    })()
      .catch((e: unknown) => {
        logger.warn("shopping_snapshot_read", {
          region,
          status: "invalid",
          message: String((e as Error).message).slice(0, 120),
        });
        // The last good copy stays (its date is shown); a broken file is never served.
        return hit?.snap ?? null;
      })
      .then((snap) => {
        snapshots.set(region, { at: Date.now(), snap });
        return snap;
      })
      .finally(() => inflight.delete(region));
    inflight.set(region, pending);
  }
  return pending;
}

type ProductRow = {
  ean: string;
  name: string;
  brand: string | null;
  size_amount: number | null;
  size_unit: string | null;
};

const productOf = (r: ProductRow): Product => ({
  ean: r.ean,
  name: r.name,
  brand: r.brand,
  size:
    r.size_amount && r.size_unit
      ? { amount: Number(r.size_amount), unit: r.size_unit as SizeUnit }
      : null,
});

/** `like` patterns built from folded words only: no wildcard a person can inject. */
const likeWord = (w: string) => `%${fold(w).replace(/[%_\\]/g, "")}%`;

export function supabaseShoppingData(): ShoppingData {
  const db = () => createAdminClient();
  return {
    async searchCatalog(words, limit) {
      const usable = words
        .map((w) => fold(w))
        .filter((w) => w.length >= 2)
        .slice(0, 6);
      if (!usable.length) return [];
      let q = db().from("shopping_products").select("ean, name, brand, size_amount, size_unit");
      for (const w of usable) q = q.like("search", likeWord(w));
      const { data, error } = await q.limit(Math.min(limit, 200));
      if (error) throw error;
      return (data ?? []).map(productOf);
    },
    async products(eans) {
      if (!eans.length) return new Map();
      const { data, error } = await db()
        .from("shopping_products")
        .select("ean, name, brand, size_amount, size_unit")
        .in("ean", [...new Set(eans)].slice(0, 200));
      if (error) throw error;
      return new Map((data ?? []).map((r) => [r.ean, productOf(r)]));
    },
    async prices(region, eans) {
      const snap = await snapshot(region);
      if (!snap) return null;
      return {
        prices: new Map(eans.map((e) => [e, pricesOf(snap, e)])),
        info: { region, date: snap.date, builtAt: snap.builtAt, dataset: snap.source.dataset },
      };
    },
    async history(region, ean, since) {
      const { data, error } = await db()
        .from("shopping_price_history")
        .select("chain_id, chain_name, observed_on, list_cents")
        .eq("ean", ean)
        .eq("region", region)
        .gte("observed_on", since)
        .order("observed_on")
        .limit(2000);
      if (error) throw error;
      const by = new Map<string, { chain: Chain; points: HistoryPoint[] }>();
      for (const r of data ?? []) {
        const e = by.get(r.chain_id) ?? {
          chain: { id: r.chain_id, name: r.chain_name },
          points: [],
        };
        e.points.push({ date: r.observed_on, cents: r.list_cents });
        by.set(r.chain_id, e);
      }
      return [...by.values()];
    },
  };
}

/** Drops the cached snapshots (after an ingestion in the same process). */
export const forgetSnapshots = () => snapshots.clear();

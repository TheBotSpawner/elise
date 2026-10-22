import "server-only";

import { z } from "zod";

import { fold, sizeLabel, type ChainPrice, type Region } from "@/core/shopping/model";
import { logger } from "@/infrastructure/observability/logger";
import {
  aggregateSepaDay,
  SEPA_CKAN,
  SEPA_HOST,
  type SepaChainPrice,
  type SepaDay,
} from "@/infrastructure/shopping/sepa";
import { buildSnapshots, encodeSnapshot, snapshotPath } from "@/infrastructure/shopping/snapshot";
import { forgetSnapshots, SHOPPING_BUCKET } from "@/infrastructure/shopping/store";
import { createAdminClient } from "@/infrastructure/supabase/admin";

import { checkPriceAlerts } from "./shopping-service";

/**
 * The daily SEPA ingestion (ADR-111). Off unless deliberately enabled: the scheduled task only
 * runs it with SHOPPING_INGEST_ENABLED=true, and `scripts/shopping-ingest.ts` runs it by hand. It
 * finds the newest daily file on the official CKAN, streams it (~330 MB, never on a request
 * handler), writes one compressed snapshot per province (~8 MB in all), refreshes the catalog,
 * records history only for products people link or watch, and checks price alerts.
 */

const resource = z.object({
  url: z.string().url(),
  name: z.string(),
  description: z.string().nullable().optional(),
  last_modified: z.string().nullable().optional(),
  format: z.string().nullable().optional(),
});
const ckan = z.object({
  success: z.literal(true),
  result: z.object({ resources: z.array(resource).max(50) }),
});

/** The newest daily file, only from the official host. */
export function newestDailyFile(raw: unknown): { url: string; date: string; name: string } | null {
  const parsed = ckan.safeParse(raw);
  if (!parsed.success) return null;
  const files = parsed.data.result.resources.flatMap((r) => {
    const date = /(\d{4}-\d{2}-\d{2})/.exec(r.description ?? "")?.[1];
    let url: URL;
    try {
      url = new URL(r.url);
    } catch {
      return [];
    }
    if (
      url.protocol !== "https:" ||
      url.hostname !== SEPA_HOST ||
      !url.pathname.startsWith("/dataset/")
    )
      return [];
    if (!date || !/\.zip$/i.test(url.pathname)) return [];
    return [{ url: url.toString(), date, name: url.pathname.split("/").pop()! }];
  });
  return files.sort((a, b) => b.date.localeCompare(a.date))[0] ?? null;
}

/** A download that only ever follows redirects within the official host. */
async function download(url: string): Promise<ReadableStream<Uint8Array>> {
  let next = url;
  for (let hop = 0; hop < 4; hop++) {
    const u = new URL(next);
    if (u.protocol !== "https:" || u.hostname !== SEPA_HOST)
      throw new Error("SEPA download left the official host");
    const r = await fetch(u, { redirect: "manual", signal: AbortSignal.timeout(15 * 60_000) });
    if (r.status >= 300 && r.status < 400 && r.headers.get("location")) {
      next = new URL(r.headers.get("location")!, u).toString();
      continue;
    }
    if (!r.ok || !r.body) throw new Error(`SEPA download ${r.status}`);
    return r.body;
  }
  throw new Error("SEPA download: too many redirects");
}

async function* chunks(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    if (value) yield value;
  }
}

/**
 * Delta-only history rows: a (product, province, chain) price is recorded only when it differs
 * from its last observation — so a chart shows real changes, never invented days.
 */
export function historyRows(
  today: readonly SepaChainPrice[],
  last: ReadonlyMap<string, number>,
): {
  ean: string;
  region: Region;
  chain_id: string;
  chain_name: string;
  observed_on: string;
  list_cents: number;
}[] {
  return today
    .filter((p) => last.get(`${p.ean}|${p.region}|${p.chain.id}`) !== p.listCents)
    .map((p) => ({
      ean: p.ean,
      region: p.region,
      chain_id: p.chain.id,
      chain_name: p.chain.name.slice(0, 120),
      observed_on: p.quoteDate,
      list_cents: p.listCents,
    }));
}

export interface IngestResult {
  status: "succeeded" | "skipped" | "failed";
  date?: string;
  stats?: Record<string, unknown>;
}

/** One day's ingestion, end to end. `source` replaces the download (a local file, tests). */
export async function ingestSepa(
  options: {
    source?: AsyncIterable<Uint8Array>;
    file?: { date: string; name: string };
    force?: boolean;
  } = {},
): Promise<IngestResult> {
  const db = createAdminClient();
  const started = Date.now();
  let file = options.file ?? null;
  let source = options.source;
  if (!source) {
    const meta = await fetch(SEPA_CKAN, { signal: AbortSignal.timeout(30_000) });
    if (!meta.ok) throw new Error(`SEPA catalog ${meta.status}`);
    const newest = newestDailyFile(await meta.json());
    if (!newest) throw new Error("SEPA catalog: no daily file");
    file = { date: newest.date, name: newest.name };
    if (!options.force) {
      const { data: done } = await db
        .from("shopping_ingestions")
        .select("id")
        .eq("dataset_date", newest.date)
        .eq("status", "succeeded")
        .limit(1);
      if (done?.length) return { status: "skipped", date: newest.date };
    }
    source = chunks(await download(newest.url));
  }
  if (!file) throw new Error("ingestSepa: a local source needs its date and name");
  const { data: run } = await db
    .from("shopping_ingestions")
    .insert({ dataset_date: file.date, source_file: file.name })
    .select("id")
    .single();
  try {
    const day: SepaDay = await aggregateSepaDay(source, new Date());
    if (!day.prices.length) throw new Error("SEPA file had no usable prices");
    const parsedMs = Date.now() - started;
    // 1. Each province's snapshot (overwritten: only today's is kept as "current").
    let bytes = 0;
    for (const [region, snap] of buildSnapshots(day, file.date, file.name)) {
      const gz = encodeSnapshot(snap);
      bytes += gz.length;
      const { error } = await db.storage
        .from(SHOPPING_BUCKET)
        .upload(snapshotPath(region), gz, { contentType: "application/gzip", upsert: true });
      if (error) throw new Error(`snapshot upload ${region}: ${error.message}`);
    }
    forgetSnapshots();
    // 2. The catalog: every product seen today.
    const products = [...day.products.values()];
    for (let i = 0; i < products.length; i += 1000) {
      const { error } = await db.from("shopping_products").upsert(
        products.slice(i, i + 1000).map((p) => ({
          ean: p.ean,
          name: p.name,
          brand: p.brand,
          size_amount: p.size?.amount ?? null,
          size_unit: p.size?.unit ?? null,
          search: fold(`${p.name} ${p.brand ?? ""} ${p.size ? sizeLabel(p.size) : ""}`).slice(
            0,
            300,
          ),
          last_seen: file.date,
        })),
        { onConflict: "ean" },
      );
      if (error) throw new Error(`catalog: ${error.message}`);
    }
    // 3. History, only for products someone links or watches.
    const [linked, watched] = await Promise.all([
      db.from("list_item_products").select("ean").limit(20_000),
      db.from("shopping_price_alerts").select("ean").eq("status", "active").limit(20_000),
    ]);
    const tracked = new Set([...(linked.data ?? []), ...(watched.data ?? [])].map((r) => r.ean));
    const trackedPrices = day.prices.filter((p) => tracked.has(p.ean));
    let historyAdded = 0;
    const eans = [...tracked];
    for (let i = 0; i < eans.length; i += 200) {
      const batch = eans.slice(i, i + 200);
      const { data: prior } = await db
        .from("shopping_price_history")
        .select("ean, region, chain_id, observed_on, list_cents")
        .in("ean", batch)
        .order("observed_on", { ascending: false })
        .limit(50_000);
      const last = new Map<string, number>();
      for (const r of prior ?? []) {
        const k = `${r.ean}|${r.region}|${r.chain_id}`;
        if (!last.has(k)) last.set(k, r.list_cents);
      }
      const rows = historyRows(
        trackedPrices.filter((p) => batch.includes(p.ean)),
        last,
      );
      for (let j = 0; j < rows.length; j += 1000) {
        const { error } = await db
          .from("shopping_price_history")
          .upsert(rows.slice(j, j + 1000), { onConflict: "ean,region,chain_id,observed_on" });
        if (error) throw new Error(`history: ${error.message}`);
        historyAdded += Math.min(1000, rows.length - j);
      }
    }
    // 4. Alerts, against this fresh data.
    const byKey = new Map<string, ChainPrice[]>();
    for (const p of trackedPrices) {
      const k = `${p.ean}|${p.region}`;
      byKey.set(k, [...(byKey.get(k) ?? []), p]);
    }
    const alerts = await checkPriceAlerts(
      (ean, region) => byKey.get(`${ean}|${region}`) ?? [],
      new Date(),
    );
    const stats = {
      ...day.stats,
      products: products.length,
      prices: day.prices.length,
      snapshotBytes: bytes,
      tracked: tracked.size,
      historyAdded,
      alerts,
      parseMs: parsedMs,
      totalMs: Date.now() - started,
    };
    if (run)
      await db
        .from("shopping_ingestions")
        .update({ status: "succeeded", finished_at: new Date().toISOString(), stats })
        .eq("id", run.id);
    logger.info("shopping_ingest", {
      status: "succeeded",
      date: file.date,
      ...stats,
      skippedStale: day.stats.skippedStale.length,
    });
    return { status: "succeeded", date: file.date, stats };
  } catch (e) {
    const message = String((e as Error).message).slice(0, 500);
    if (run)
      await db
        .from("shopping_ingestions")
        .update({ status: "failed", finished_at: new Date().toISOString(), error: message })
        .eq("id", run.id);
    logger.error("shopping_ingest", { status: "failed", date: file.date, message });
    return { status: "failed", date: file.date };
  }
}

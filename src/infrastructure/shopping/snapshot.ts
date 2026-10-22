import { gunzipSync, gzipSync } from "node:zlib";

import { z } from "zod";

import { regionSchema, type ChainPrice, type Region } from "@/core/shopping/model";

import type { SepaDay } from "./sepa";

/**
 * One province's prices of one day (ADR-111), compact: chains and promotion texts once, then per
 * barcode one row per chain — [chain, list, min, branches, promo, promo text, condition text]
 * (-1 = none). ~2 MB gzipped for the largest province. Validated when read: a file that doesn't
 * match is never served.
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const row = z.tuple([
  z.number().int().min(0),
  z.number().int().positive(),
  z.number().int().positive(),
  z.number().int().positive(),
  z.number().int().min(-1),
  z.number().int().min(-1),
  z.number().int().min(-1),
]);

export const snapshotSchema = z.object({
  v: z.literal(1),
  region: regionSchema,
  /** The dataset day it comes from. */
  date: isoDate,
  builtAt: z.string(),
  source: z.object({ dataset: z.string(), file: z.string() }),
  chains: z
    .array(z.object({ id: z.string().max(20), name: z.string().max(120), quoteDate: isoDate }))
    .max(300),
  labels: z.array(z.string().max(120)).max(200_000),
  prices: z.record(z.string().regex(/^\d{13,14}$/), z.array(z.unknown()).max(300)),
});
export type Snapshot = z.infer<typeof snapshotSchema>;

export function buildSnapshots(
  day: SepaDay,
  date: string,
  file: string,
  builtAt = new Date(),
): Map<Region, Snapshot> {
  const out = new Map<Region, Snapshot>();
  const chainIdx = new Map<Region, Map<string, number>>();
  const labelIdx = new Map<Region, Map<string, number>>();
  const label = (r: Region, s: string | null) => {
    if (!s) return -1;
    const m = labelIdx.get(r)!;
    let i = m.get(s);
    if (i === undefined) {
      i = m.size;
      m.set(s, i);
      out.get(r)!.labels.push(s);
    }
    return i;
  };
  for (const p of day.prices) {
    let snap = out.get(p.region);
    if (!snap) {
      snap = {
        v: 1,
        region: p.region,
        date,
        builtAt: builtAt.toISOString(),
        source: { dataset: "https://datos.produccion.gob.ar/dataset/sepa-precios", file },
        chains: [],
        labels: [],
        prices: {},
      };
      out.set(p.region, snap);
      chainIdx.set(p.region, new Map());
      labelIdx.set(p.region, new Map());
    }
    const chains = chainIdx.get(p.region)!;
    let c = chains.get(p.chain.id);
    if (c === undefined) {
      c = snap.chains.length;
      chains.set(p.chain.id, c);
      snap.chains.push({ id: p.chain.id, name: p.chain.name, quoteDate: p.quoteDate });
    }
    (snap.prices[p.ean] ??= []).push([
      c,
      p.listCents,
      p.minCents,
      p.branches,
      p.promoCents ?? -1,
      label(p.region, p.promoLabel),
      label(p.region, p.conditionalLabel),
    ]);
  }
  return out;
}

export const encodeSnapshot = (s: Snapshot) => gzipSync(JSON.stringify(s), { level: 9 });

export function decodeSnapshot(bytes: Uint8Array): Snapshot {
  return snapshotSchema.parse(JSON.parse(gunzipSync(bytes).toString("utf8")));
}

/** One barcode's prices in a snapshot (rows that don't validate are dropped, never guessed). */
export function pricesOf(s: Snapshot, ean: string): ChainPrice[] {
  const rows = s.prices[ean] ?? [];
  const out: ChainPrice[] = [];
  for (const raw of rows) {
    const r = row.safeParse(raw);
    if (!r.success) continue;
    const [c, list, min, branches, promo, promoLabel, condLabel] = r.data;
    const chain = s.chains[c];
    if (!chain) continue;
    out.push({
      chain: { id: chain.id, name: chain.name },
      region: s.region,
      listCents: list,
      minCents: min,
      branches,
      promoCents: promo > 0 ? promo : null,
      promoLabel: promoLabel >= 0 ? (s.labels[promoLabel] ?? null) : null,
      conditionalLabel: condLabel >= 0 ? (s.labels[condLabel] ?? null) : null,
      quoteDate: chain.quoteDate,
    });
  }
  return out;
}

/** Storage path of a province's snapshot: one current object per province (overwritten daily). */
export const snapshotPath = (region: Region) => `current/${region}.json.gz`;

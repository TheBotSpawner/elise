import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import type { ProviderFactory, ToolRunEnv } from "@/core/agents/tools";
import type { NativeList } from "@/core/capabilities/lists";
import type { MarketplaceApi, MarketplaceMode } from "@/core/shopping/marketplace";
import {
  fold,
  type AlertView,
  type ChainPrice,
  type LinkedLine,
  type Product,
  type Region,
  type ShoppingCapability,
  type ShoppingData,
} from "@/core/shopping/model";
import type { WebCapability } from "@/core/web/model";
import { decodeSnapshot, pricesOf, type Snapshot } from "@/infrastructure/shopping/snapshot";

import { makeCtx, NATIVE_BINDING } from "./core-fakes";

/**
 * Shopping data in memory (ADR-111): fixtures for tests, or a real SEPA day measured locally
 * (scripts/sepa-measure.ts <zip> <dir>) for the live smoke — never a database.
 */
export function memoryShoppingData(
  products: Product[],
  prices: Map<Region, Map<string, ChainPrice[]>> | ((r: Region) => Snapshot | null),
  date = "2026-10-22",
): ShoppingData & { searched: string[][] } {
  const byEan = new Map(products.map((p) => [p.ean, p]));
  const searched: string[][] = [];
  return {
    searched,
    async searchCatalog(words, limit) {
      searched.push([...words]);
      const ws = words.map(fold);
      return products
        .filter((p) => ws.every((w) => fold(`${p.name} ${p.brand ?? ""}`).includes(w)))
        .slice(0, limit);
    },
    async products(eans) {
      return new Map(eans.flatMap((e) => (byEan.has(e) ? [[e, byEan.get(e)!] as const] : [])));
    },
    async prices(region, eans) {
      if (typeof prices === "function") {
        const snap = prices(region);
        if (!snap) return null;
        return {
          prices: new Map(eans.map((e) => [e, pricesOf(snap, e)])),
          info: { region, date: snap.date, builtAt: snap.builtAt, dataset: snap.source.dataset },
        };
      }
      const m = prices.get(region);
      if (!m) return null;
      return {
        prices: new Map(eans.map((e) => [e, m.get(e) ?? []])),
        info: {
          region,
          date,
          builtAt: `${date}T12:00:00Z`,
          dataset: "https://datos.produccion.gob.ar/dataset/sepa-precios",
        },
      };
    },
    async history() {
      return [];
    },
  };
}

/** A real SEPA day measured locally (catalog.json + AR-*.json.gz), when present. */
export function realShoppingData(dir: string): ShoppingData | null {
  if (!existsSync(join(dir, "catalog.json"))) return null;
  const products = JSON.parse(readFileSync(join(dir, "catalog.json"), "utf8")) as Product[];
  const cache = new Map<Region, Snapshot | null>();
  return memoryShoppingData(products, (r) => {
    if (!cache.has(r)) {
      const f = join(dir, `${r}.json.gz`);
      cache.set(r, existsSync(f) ? decodeSnapshot(readFileSync(f)) : null);
    }
    return cache.get(r)!;
  });
}

export function shoppingEnv(
  data: ShoppingData,
  opts: {
    region?: Region | null;
    lists?: NativeList[];
    links?: Map<string, { ean: string; quantity: number }>;
    marketplace?: MarketplaceApi | null;
    mode?: MarketplaceMode | null;
    web?: Partial<WebCapability>;
    invoke?: ToolRunEnv["invoke"];
    timezone?: string;
  } = {},
) {
  let region = opts.region ?? null;
  let mode = opts.mode ?? null;
  const links = opts.links ?? new Map<string, { ean: string; quantity: number }>();
  const alerts: AlertView[] = [];
  const lists = opts.lists ?? [];
  const shop: ShoppingCapability = {
    data,
    marketplace: opts.marketplace ?? null,
    marketplaceMode: async () => mode,
    saveMarketplaceMode: async (m) => void (mode = m),
    region: async () => region,
    saveRegion: async (r) => void (region = r),
    listLines: async (listId) =>
      (lists.find((l) => l.id === listId)?.items ?? [])
        .filter((i) => !i.checked)
        .map((i): LinkedLine => ({
          itemId: i.id,
          label: i.content,
          ean: links.get(i.id)?.ean ?? null,
          quantity: links.get(i.id)?.quantity ?? 1,
          method: links.has(i.id) ? "confirmed" : null,
        })),
    link: async (itemId, ean, quantity) => void links.set(itemId, { ean, quantity }),
    unlink: async (itemId) => void links.delete(itemId),
    alerts: {
      list: async () => alerts,
      create: async (a) => {
        const v: AlertView = {
          id: `a${alerts.length}`,
          ...a,
          status: "active",
          state: "armed",
          lastCheck: null,
          lastCheckedAt: null,
          lastBestCents: null,
          lastBestChain: null,
          lastQuoteDate: null,
        };
        alerts.push(v);
        return v;
      },
      remove: async (id) =>
        void alerts.splice(
          alerts.findIndex((a) => a.id === id),
          1,
        ),
    },
  };
  const listsProvider = {
    find: async (ref: string) => lists.filter((l) => l.id === ref || fold(l.name) === fold(ref)),
  };
  const env: ToolRunEnv = {
    ctx: makeCtx({
      now: new Date("2026-10-22T15:00:00-03:00"),
      ...(opts.timezone ? { timezone: opts.timezone } : {}),
    }),
    ...(opts.invoke ? { invoke: opts.invoke } : {}),
    binding: NATIVE_BINDING,
    providers: {
      get: ((capability: string) =>
        capability === "lists"
          ? listsProvider
          : capability === "web_search"
            ? opts.web
            : shop) as ProviderFactory["get"],
    },
  };
  return { env, shop, links, alerts, region: () => region, mode: () => mode };
}

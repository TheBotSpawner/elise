import { Inflate, Unzip, UnzipInflate } from "fflate";

import {
  canonicalEan,
  regionSchema,
  sizeIn,
  unitOf,
  type ChainPrice,
  type Product,
  type Region,
} from "@/core/shopping/model";

/**
 * SEPA (Sistema Electrónico de Publicidad de Precios Argentinos, ADR-111): the official daily
 * dataset of the Secretaría de Comercio, CC-BY 4.0
 * (https://datos.produccion.gob.ar/dataset/sepa-precios). One ZIP per weekday (~330 MB) holds one
 * ZIP per company with comercio.csv, sucursales.csv and productos.csv (pipe-separated, one row per
 * product per branch).
 *
 * This turns one day into ELISE's aggregates, streaming — never the whole file in memory: per
 * chain (bandera) and province, the median list price over the branches that published it, the
 * lowest one, how many branches, and the promotions apart (promo 1 is general; promo 2 has
 * conditions and is only described). Only real barcodes (`productos_ean = 1`) are kept: a chain's
 * internal code can't be compared across chains. A company whose data is older than `maxAgeDays`
 * (some republish files from years ago) is skipped and reported.
 */

export const SEPA_DATASET_URL = "https://datos.produccion.gob.ar/dataset/sepa-precios";
export const SEPA_CKAN =
  "https://datos.produccion.gob.ar/api/3/action/package_show?id=sepa-precios";
/** The only host a SEPA download may come from (no URL from a user or the model). */
export const SEPA_HOST = "datos.produccion.gob.ar";

export interface SepaChainPrice extends ChainPrice {
  ean: string;
}

export interface SepaDay {
  products: Map<string, Product>;
  prices: SepaChainPrice[];
  stats: {
    companies: number;
    skippedStale: { company: string; lastUpdate: string }[];
    rows: number;
    rowsWithBarcode: number;
    rejected: number;
    chains: number;
  };
}

const decoder = () => new TextDecoder("utf-8");

/**
 * A banner as people say it: Carrefour publishes "Market", "Express", "Maxi" — a generic name
 * gets the brand of its company's site ("Carrefour Market"), so "Carrefour" finds all of them.
 */
export function bannerName(name: string, url: string): string {
  const n = name.trim().replace(/\s+/g, " ");
  const brand = /^(?:https?:\/\/)?(?:www\.)?([a-z]+)\./i.exec(url.trim())?.[1];
  if (brand && /^(market|express|maxi|hiper|super|mini|city)$/i.test(n))
    return `${brand.charAt(0).toUpperCase()}${brand.slice(1).toLowerCase()} ${n}`;
  return n;
}

/** Lines of a stream of bytes (a CSV file inside a ZIP). */
class Lines {
  private rest = "";
  private dec = decoder();
  constructor(private readonly onLine: (line: string) => void) {}
  push(chunk: Uint8Array, final: boolean) {
    const text = this.rest + this.dec.decode(chunk, { stream: !final });
    const lines = text.split(/\r?\n/);
    this.rest = final ? "" : (lines.pop() ?? "");
    for (const l of lines) if (l) this.onLine(l);
  }
}

/** A price as SEPA writes it ("24727", "1234.50", "1234,5") → cents, or null if unusable. */
export function cents(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number(raw.trim().replace(",", "."));
  if (!Number.isFinite(n) || n <= 0 || n > 50_000_000) return null;
  return Math.round(n * 100);
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2);
};

const mode = (xs: string[]) => {
  const c = new Map<string, number>();
  for (const x of xs) c.set(x, (c.get(x) ?? 0) + 1);
  return [...c.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
};

interface Agg {
  list: number[];
  promo: number[];
  promoLabels: string[];
  conditionalLabels: string[];
}

/**
 * Read files of one company ZIP (in memory) by its central directory — sizes and offsets from
 * there, so data descriptors and ZIP64 work — inflating each one in 1 MB steps to its handler.
 */
export function readZip(
  data: Uint8Array,
  handlers: Record<string, (chunk: Uint8Array, final: boolean) => void>,
) {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let eocd = -1;
  for (let i = data.length - 22; i >= Math.max(0, data.length - 66_000); i--)
    if (v.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  if (eocd < 0) throw new Error("zip: no central directory");
  let count = v.getUint16(eocd + 10, true);
  let dir = v.getUint32(eocd + 16, true);
  // ZIP64 end of central directory.
  if (dir === 0xffffffff && eocd >= 20 && v.getUint32(eocd - 20, true) === 0x07064b50) {
    const at = Number(v.getBigUint64(eocd - 12, true));
    count = Number(v.getBigUint64(at + 32, true));
    dir = Number(v.getBigUint64(at + 48, true));
  }
  const names = new TextDecoder();
  for (let n = 0, p = dir; n < count; n++) {
    if (v.getUint32(p, true) !== 0x02014b50) throw new Error("zip: bad central directory");
    const method = v.getUint16(p + 10, true);
    let size = v.getUint32(p + 20, true);
    const nameLen = v.getUint16(p + 28, true);
    const extraLen = v.getUint16(p + 30, true);
    const commentLen = v.getUint16(p + 32, true);
    let offset = v.getUint32(p + 42, true);
    const name = names.decode(data.subarray(p + 46, p + 46 + nameLen));
    // ZIP64 sizes/offset live in the extra field when the 32-bit ones are saturated.
    for (let e = p + 46 + nameLen; e < p + 46 + nameLen + extraLen;) {
      const id = v.getUint16(e, true);
      const len = v.getUint16(e + 2, true);
      if (id === 0x0001) {
        let q = e + 4;
        if (v.getUint32(p + 24, true) === 0xffffffff) q += 8; // uncompressed size
        if (size === 0xffffffff) {
          size = Number(v.getBigUint64(q, true));
          q += 8;
        }
        if (offset === 0xffffffff) offset = Number(v.getBigUint64(q, true));
      }
      e += 4 + len;
    }
    p += 46 + nameLen + extraLen + commentLen;
    const h = handlers[name.split("/").pop() ?? ""];
    if (!h) continue;
    const start = offset + 30 + v.getUint16(offset + 26, true) + v.getUint16(offset + 28, true);
    const body = data.subarray(start, start + size);
    if (method === 0) {
      h(body, true);
      continue;
    }
    if (method !== 8) throw new Error(`zip: method ${method}`);
    const inflate = new Inflate((chunk, final) => h(chunk, final));
    const STEP = 1 << 20;
    for (let i = 0; i < body.length; i += STEP)
      inflate.push(body.subarray(i, Math.min(body.length, i + STEP)), i + STEP >= body.length);
  }
}

/**
 * One company's ZIP → its products and aggregated prices. Branches first (their province), then
 * products: the ZIP is read twice, since the files come in any order.
 */
export async function companyAggregates(
  data: Uint8Array,
  now: Date,
  maxAgeDays: number,
  into: SepaDay,
) {
  const chainName = new Map<string, string>();
  let lastUpdate = "";
  let companyName = "";
  const branchRegion = new Map<string, Region>();
  let header: string[] | null = null;
  const comercio = new Lines((line) => {
    const f = line.split("|");
    if (f[0] === "id_comercio" || f.length < 8 || !/^\d+$/.test(f[0]!)) return;
    chainName.set(`${f[0]}-${f[1]}`, bannerName(f[4]!, f[5] ?? ""));
    companyName = f[3]!.trim();
    lastUpdate = f[6]!.trim();
  });
  const sucursales = new Lines((line) => {
    const f = line.split("|");
    if (f[0] === "id_comercio" || f.length < 14) return;
    const region = regionSchema.safeParse(f[13]!.trim().toUpperCase());
    if (region.success) branchRegion.set(`${f[0]}-${f[1]}-${f[2]}`, region.data);
  });
  readZip(data, {
    "comercio.csv": (c, end) => comercio.push(c, end),
    "sucursales.csv": (c, end) => sucursales.push(c, end),
  });
  const updated = Date.parse(lastUpdate.replace(/(\d{2})(\d{2})$/, "$1:$2"));
  if (!Number.isFinite(updated) || now.getTime() - updated > maxAgeDays * 86_400_000) {
    into.stats.skippedStale.push({ company: companyName || "?", lastUpdate });
    return;
  }
  into.stats.companies++;
  const quoteDate = new Date(updated - 3 * 3_600_000).toISOString().slice(0, 10);
  const aggs = new Map<string, Agg>();
  const productos = new Lines((line) => {
    if (!header) {
      header = line.split("|");
      return;
    }
    into.stats.rows++;
    const f = line.split("|");
    // id_comercio|id_bandera|id_sucursal|id_producto|productos_ean|descripcion|cantidad|unidad|
    // marca|precio_lista|precio_ref|cant_ref|unidad_ref|promo1|leyenda1|promo2|leyenda2
    if (f.length < 10 || f[4]!.trim() !== "1") return;
    const ean = canonicalEan(f[3]!.trim());
    if (!ean) return void into.stats.rejected++;
    const region = branchRegion.get(`${f[0]}-${f[1]}-${f[2]}`);
    const list = cents(f[9]);
    if (!region || list === null) return void into.stats.rejected++;
    into.stats.rowsWithBarcode++;
    if (!into.products.has(ean)) {
      const name = f[5]!.trim().replace(/\s+/g, " ").slice(0, 200);
      const presented = unitOf(f[7] ?? "");
      const amount = Number((f[6] ?? "").replace(",", "."));
      const fromName = sizeIn(name);
      into.products.set(ean, {
        ean,
        name,
        brand: f[8]?.trim().slice(0, 80) || null,
        // The name's size wins: some chains publish "1 gr" for a 74 g deodorant.
        size:
          fromName ??
          (presented && amount > 1
            ? { amount: amount * presented.factor, unit: presented.unit }
            : null),
      });
    }
    const key = `${ean}|${f[0]}-${f[1]}|${region}`;
    let a = aggs.get(key);
    if (!a) aggs.set(key, (a = { list: [], promo: [], promoLabels: [], conditionalLabels: [] }));
    a.list.push(list);
    const p1 = cents(f[13]);
    if (p1 !== null && p1 < list) {
      a.promo.push(p1);
      if (f[14]?.trim()) a.promoLabels.push(f[14].trim().slice(0, 120));
    }
    if (f[16]?.trim()) a.conditionalLabels.push(f[16].trim().slice(0, 120));
  });
  readZip(data, { "productos.csv": (c, end) => productos.push(c, end) });
  for (const [key, a] of aggs) {
    const [ean, chainId, region] = key.split("|") as [string, string, Region];
    into.prices.push({
      ean,
      chain: { id: chainId, name: chainName.get(chainId) ?? chainId },
      region,
      listCents: median(a.list),
      minCents: Math.min(...a.list),
      branches: a.list.length,
      // A general promotion only when most branches that carry the product have it.
      promoCents: a.promo.length * 2 >= a.list.length ? median(a.promo) : null,
      promoLabel: a.promo.length * 2 >= a.list.length ? mode(a.promoLabels) : null,
      conditionalLabel: mode(a.conditionalLabels),
      quoteDate,
    });
  }
}

/**
 * A whole day's ZIP (as a stream of bytes) → products and aggregated prices. Company ZIPs are
 * buffered one at a time (the largest is ~100 MB compressed), never the whole day.
 */
export async function aggregateSepaDay(
  source: AsyncIterable<Uint8Array>,
  now: Date,
  maxAgeDays = 4,
): Promise<SepaDay> {
  const day: SepaDay = {
    products: new Map(),
    prices: [],
    stats: { companies: 0, skippedStale: [], rows: 0, rowsWithBarcode: 0, rejected: 0, chains: 0 },
  };
  const companies: Uint8Array[] = [];
  let failed: Error | null = null;
  const outer = new Unzip((file) => {
    if (!/\.zip$/i.test(file.name)) return;
    const parts: Uint8Array[] = [];
    file.ondata = (err, chunk, final) => {
      if (err) return void (failed = err);
      parts.push(chunk);
      if (final) {
        const size = parts.reduce((s, p) => s + p.length, 0);
        const all = new Uint8Array(size);
        let o = 0;
        for (const p of parts) {
          all.set(p, o);
          o += p.length;
        }
        if (size) companies.push(all);
      }
    };
    file.start();
  });
  outer.register(UnzipInflate);
  for await (const chunk of source) {
    outer.push(chunk);
    if (failed) throw failed;
    // Process finished companies right away: one company's bytes in memory at a time.
    while (companies.length) await companyAggregates(companies.shift()!, now, maxAgeDays, day);
  }
  outer.push(new Uint8Array(0), true);
  while (companies.length) await companyAggregates(companies.shift()!, now, maxAgeDays, day);
  day.stats.chains = new Set(day.prices.map((p) => p.chain.id)).size;
  return day;
}

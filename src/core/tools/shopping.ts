import { z } from "zod";

import type { ToolDefinition, ToolRunEnv } from "../agents/tools";
import { AppError } from "../errors";
import {
  AR_PROVINCES,
  ars,
  canonicalEan,
  compareBasket,
  fold,
  perUnitCents,
  priceChange,
  rankCandidates,
  regionFromWords,
  sizeLabel,
  stem,
  stepSeries,
  type BasketLine,
  type ChainPrice,
  type Product,
  type Region,
  type ShoppingCapability,
} from "../shopping/model";
import { addDays, todayIn } from "../time";
import type { SurfacePayloads } from "../workspace/registry";

/**
 * Supermarket price tools (ADR-111). Public SEPA data in ELISE's own copy: products by barcode
 * or name, a product's prices per chain in a province, a list's comparison, price history and
 * alerts. The model chooses what to look up; every match rule and every amount is computed here.
 * A name never becomes a product on its own: the person picks among real catalog products.
 */

type Payload = SurfacePayloads["shopping"];

const shop = (env: ToolRunEnv): ShoppingCapability => env.providers.get("shopping", env.binding);
const SOURCE = {
  name: "SEPA, Secretaría de Comercio",
  url: "https://datos.produccion.gob.ar/dataset/sepa-precios",
};

const RULES =
  'Say these are reference prices for the province (median of each chain\'s branches that published that day), with the data date — never "the branch near you charges exactly X". Promotions with conditions (a bank, a card) are never part of a total. Voice: two or three short sentences, the detail stays on screen.';

const regionInput = z
  .string()
  .trim()
  .max(80)
  .optional()
  .describe(
    'Where they shop, only if they said it now ("en Córdoba", "CABA"). Omit to use their saved province.',
  );

type RegionPick = { ok: true; region: Region } | { ok: false; output: Record<string, unknown> };

/** The province: what they said now, else their saved one — never a guess or a default. */
async function regionFor(env: ToolRunEnv, said: string | undefined): Promise<RegionPick> {
  if (said) {
    const r = regionFromWords(said);
    if (r.kind === "one") return { ok: true, region: r.region };
    return {
      ok: false,
      output: {
        needsRegion: true,
        options:
          r.kind === "ambiguous"
            ? r.options.map((x) => AR_PROVINCES[x])
            : Object.values(AR_PROVINCES),
        instructions:
          r.kind === "ambiguous"
            ? 'Prices differ between the city and the province: ask which ("¿Ciudad de Buenos Aires o provincia?"). Nothing was looked up.'
            : "That isn't an Argentine province ELISE knows. Ask which province they shop in.",
      },
    };
  }
  const saved = await shop(env).region();
  if (saved) return { ok: true, region: saved };
  return {
    ok: false,
    output: {
      needsRegion: true,
      options: Object.values(AR_PROVINCES),
      instructions:
        'Prices are compared by province and the user has none saved. Ask once which province they shop in ("¿En qué provincia hacés las compras?"); when they answer, call shopping.setRegion, then repeat the request. Never assume Buenos Aires.',
    },
  };
}

const productView = (p: Product): Payload["product"] & object => ({
  ean: p.ean,
  name: p.name.slice(0, 200),
  brand: p.brand,
  size: p.size ? sizeLabel(p.size) : null,
});

const chainView = (c: ChainPrice, product: Product | null): Payload["chains"][number] => {
  const unit = perUnitCents(c.listCents, product?.size ?? null);
  return {
    id: c.chain.id,
    name: c.chain.name.slice(0, 120),
    listCents: c.listCents,
    minCents: c.minCents,
    branches: Math.min(10_000, c.branches),
    perUnit: unit ? { cents: unit.cents, per: unit.per as "kg" | "L" | "u" } : null,
    promoCents: c.promoCents,
    promoLabel: c.promoLabel,
    conditionalLabel: c.conditionalLabel,
    quoteDate: c.quoteDate,
  };
};

const empty = (region: Region, mode: Payload["mode"], date: string | null): Payload => ({
  mode,
  region,
  regionName: AR_PROVINCES[region],
  product: null,
  chains: [],
  basket: null,
  history: null,
  candidates: [],
  alerts: [],
  date,
  source: SOURCE,
  notes: [],
});

/** Chains the person named ("Día, Carrefour y Coto") → ids among those with data. */
function chainFilter(names: string[] | undefined, available: { id: string; name: string }[]) {
  if (!names?.length) return { ids: undefined, unknown: [] as string[] };
  const ids: string[] = [];
  const unknown: string[] = [];
  for (const n of names) {
    const w = fold(n);
    const hit = available.filter((c) =>
      new RegExp(`(^|\\W)${w.replace(/[^a-z0-9 ]/g, "")}(\\W|$)`).test(fold(c.name)),
    );
    if (hit.length) ids.push(...hit.map((c) => c.id));
    else unknown.push(n);
  }
  return { ids: [...new Set(ids)], unknown };
}

const unavailableOutput = {
  available: false,
  instructions:
    "ELISE's supermarket price data isn't loaded yet (no data for this province). Say so plainly; don't search the web for prices or invent any.",
};

/**
 * Real catalog products for words, best first — never invented, never picked for the person.
 * Among equally good matches, what is sold in the person's province and in more chains comes
 * first (a product only one chain sells can't be compared).
 */
async function candidatesFor(env: ToolRunEnv, query: string, region: Region, limit = 5) {
  const words = fold(query)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 3 && !/^\d/.test(w))
    .map(stem);
  const pool = words.length ? await shop(env).data.searchCatalog(words.slice(0, 3), 400) : [];
  const ranked = rankCandidates(query, pool).slice(0, 40);
  const priced = ranked.length
    ? await shop(env).data.prices(
        region,
        ranked.map((c) => c.product.ean),
      )
    : null;
  const chainsOf = (ean: string) => priced?.prices.get(ean) ?? [];
  return ranked
    .map((c) => ({ ...c, prices: chainsOf(c.product.ean) }))
    .sort(
      (a, b) =>
        Number(b.prices.length > 0) - Number(a.prices.length > 0) ||
        Number(b.extraVariant.length === 0) - Number(a.extraVariant.length === 0) ||
        b.confidence - a.confidence ||
        b.prices.length - a.prices.length,
    )
    .slice(0, limit);
}

// ── Find a product ───────────────────────────────────────────────────────────

const findInput = z
  .object({
    query: z
      .string()
      .trim()
      .min(2)
      .max(120)
      .describe(
        'What they asked for, with brand and size if said ("leche entera 1 L", "yerba Playadito 1 kg"), or a barcode.',
      ),
    region: regionInput,
  })
  .strict();

export const findProductTool: ToolDefinition = {
  name: "shopping.findProduct",
  capability: "shopping",
  operation: "findProduct",
  description:
    '"¿Cuánto sale la leche La Serenísima 1 L?", "¿dónde consigo más barata la yerba?", a barcode: real products from the published price data with their price per chain in the user\'s province. A barcode is exact; words give options the user picks from (never pick for them).',
  input: findInput,
  async describe(raw) {
    return { summary: `Find product: ${findInput.parse(raw).query}` };
  },
  async run(raw, env) {
    const q = findInput.parse(raw);
    const region = await regionFor(env, q.region);
    if (!region.ok) return { output: region.output };
    const s = shop(env);
    const code = /^\d[\d\s-]{6,16}$/.test(q.query) ? canonicalEan(q.query) : null;
    if (code) {
      const [products, priced] = await Promise.all([
        s.data.products([code]),
        s.data.prices(region.region, [code]),
      ]);
      if (!priced) return { output: unavailableOutput };
      const product = products.get(code) ?? null;
      const prices = [...(priced.prices.get(code) ?? [])].sort((a, b) => a.listCents - b.listCents);
      if (!product && !prices.length)
        return {
          output: { found: false, instructions: "No published product has that barcode. Say so." },
        };
      const payload: Payload = {
        ...empty(region.region, "product", priced.info.date),
        product: product
          ? productView(product)
          : { ean: code, name: code, brand: null, size: null },
        chains: prices.slice(0, 40).map((c) => chainView(c, product)),
        notes: prices.length
          ? []
          : ["No hay precios publicados para este producto en esta provincia."],
      };
      return {
        output: {
          match: "barcode",
          product: payload.product,
          region: AR_PROVINCES[region.region],
          dataDate: priced.info.date,
          prices: prices.slice(0, 12).map((c) => ({
            chain: c.chain.name,
            price: ars(c.listCents),
            promo: c.promoCents ? ars(c.promoCents) : null,
            conditional: c.conditionalLabel,
          })),
          instructions: RULES,
        },
        display: {
          kind: "shopping",
          shopping: payload,
          title: payload.product!.name,
          key: `shopping:product:${code}:${region.region}`,
        },
      };
    }
    const found = await candidatesFor(env, q.query, region.region);
    if (!found.length)
      return {
        output: {
          found: false,
          instructions:
            "No published product matches those words (the data only has products with a barcode that chains report). Say so; offer to try other words or the barcode.",
        },
      };
    const priced = await s.data.prices(
      region.region,
      found.map((c) => c.product.ean),
    );
    if (!priced) return { output: unavailableOutput };
    const payload: Payload = {
      ...empty(region.region, "resolution", priced.info.date),
      candidates: found.map((c) => {
        const ps = priced.prices.get(c.product.ean) ?? [];
        return {
          ...productView(c.product),
          forLine: null,
          extraVariant: c.extraVariant,
          fromCents: ps.length ? Math.min(...ps.map((p) => p.listCents)) : null,
        };
      }),
    };
    return {
      output: {
        match: "name",
        options: payload.candidates.map((c, i) => ({
          n: i + 1,
          ean: c.ean,
          name: c.name,
          size: c.size,
          from: c.fromCents !== null ? ars(c.fromCents) : "no price here",
          chains: priced.prices.get(c.ean)?.length ?? 0,
          ...(c.extraVariant.length ? { differs: c.extraVariant } : {}),
        })),
        instructions:
          "These are real products, not one confirmed match. If exactly one clearly is what they named (same kind, variant and size), you may give its prices with shopping.productPrices; otherwise ask which (by number). A product marked `differs` is a different variant — never present it as what they asked for.",
      },
      display: {
        kind: "shopping",
        shopping: payload,
        title: q.query,
        key: `shopping:find:${fold(q.query)}`,
      },
    };
  },
};

// ── One product's prices ─────────────────────────────────────────────────────

const pricesInput = z.object({ ean: z.string().regex(/^\d{8,14}$/), region: regionInput }).strict();

export const productPricesTool: ToolDefinition = {
  name: "shopping.productPrices",
  capability: "shopping",
  operation: "productPrices",
  description:
    "One product's prices per chain in the user's province (list price, price per liter/kilo, general and conditional promotions). The ean comes from shopping.findProduct or a linked list item.",
  input: pricesInput,
  async describe(raw) {
    return { summary: `Prices for ${pricesInput.parse(raw).ean}` };
  },
  async run(raw, env) {
    const q = pricesInput.parse(raw);
    return findProductTool.run({ query: q.ean, ...(q.region ? { region: q.region } : {}) }, env);
  },
};

// ── Compare a list (or items) ────────────────────────────────────────────────

const compareInput = z
  .object({
    list: z
      .string()
      .trim()
      .max(120)
      .optional()
      .describe('One of the user\'s Lists by name ("compras", "súper").'),
    items: z
      .array(
        z
          .object({
            ean: z
              .string()
              .regex(/^\d{8,14}$/)
              .optional(),
            name: z.string().trim().max(120).optional(),
            quantity: z.number().int().min(1).max(99).default(1),
          })
          .strict(),
      )
      .max(40)
      .optional()
      .describe("Products said right now (not on a list): an ean when known, else the words."),
    chains: z
      .array(z.string().trim().min(2).max(40))
      .max(10)
      .optional()
      .describe('Only these chains ("Día", "Coto", "Carrefour").'),
    region: regionInput,
  })
  .strict()
  .refine((q) => q.list || q.items?.length, "A list or items");

export const compareTool: ToolDefinition = {
  name: "shopping.compare",
  capability: "shopping",
  operation: "compare",
  description:
    '"Comparame mi lista del súper", "compará mi lista entre Día, Carrefour y Coto", "tengo que comprar yerba, aceite y dos leches: ¿dónde me conviene?": where a basket is cheaper, by chain, in the user\'s province. ELISE computes three honest totals: products in common to every chain, what each chain has, and the full list only where every product is priced.',
  input: compareInput,
  async describe(raw) {
    const q = compareInput.parse(raw);
    return { summary: `Compare ${q.list ?? `${q.items?.length ?? 0} items`}` };
  },
  async run(raw, env) {
    const q = compareInput.parse(raw);
    const region = await regionFor(env, q.region);
    if (!region.ok) return { output: region.output };
    const s = shop(env);
    let lines: BasketLine[] = [];
    let list: { id: string; name: string } | null = null;
    const unresolvedFor = new Map<string, string>();
    if (q.list) {
      const matches = await env.providers.get("lists", env.binding).find(q.list);
      if (matches.length !== 1)
        return {
          output: {
            found: false,
            ...(matches.length ? { candidates: matches.map((l) => l.name) } : {}),
            instructions: matches.length
              ? "Several lists match; ask which."
              : "No list by that name; name their lists or ask.",
          },
        };
      list = { id: matches[0]!.id, name: matches[0]!.name };
      const linked = await s.listLines(list.id);
      if (!linked.length)
        return { output: { empty: true, instructions: "That list has no open items. Say so." } };
      lines = linked.map((l) => ({
        key: l.itemId,
        label: l.label,
        ean: l.ean,
        quantity: l.quantity,
      }));
      for (const l of linked) if (!l.ean) unresolvedFor.set(l.itemId, l.label);
    } else {
      lines = q.items!.map((it, i) => {
        const ean = it.ean ? canonicalEan(it.ean) : null;
        if (!ean) unresolvedFor.set(String(i), it.name ?? it.ean ?? "?");
        return { key: String(i), label: it.name ?? it.ean ?? "?", ean, quantity: it.quantity };
      });
    }
    const eans = [...new Set(lines.flatMap((l) => (l.ean ? [l.ean] : [])))];
    const [products, priced] = await Promise.all([
      s.data.products(eans),
      s.data.prices(region.region, eans),
    ]);
    if (!priced) return { output: unavailableOutput };
    const available = new Map<string, { id: string; name: string }>();
    for (const ps of priced.prices.values()) for (const p of ps) available.set(p.chain.id, p.chain);
    const filter = chainFilter(q.chains, [...available.values()]);
    const result = compareBasket(region.region, lines, priced.prices, products, {
      chains: filter.ids,
    });
    // Options for lines without a product (at most five lines, three each): to ask, never to pick.
    const options: Payload["candidates"] = [];
    for (const [key, label] of [...unresolvedFor].slice(0, 5)) {
      for (const c of await candidatesFor(env, label, region.region, 3))
        options.push({
          ...productView(c.product),
          forLine: label.slice(0, 500),
          extraVariant: c.extraVariant,
          fromCents: null,
        });
      void key;
    }
    const chainName = (id: string) =>
      result.chains.find((c) => c.chain.id === id)?.chain.name ?? id;
    const payload: Payload = {
      ...empty(region.region, "basket", priced.info.date),
      basket: {
        listId: list?.id ?? null,
        listName: list?.name ?? null,
        requested: result.lines.length,
        commonLines: result.commonLines,
        chains: result.chains.map((c) => ({
          id: c.chain.id,
          name: c.chain.name.slice(0, 120),
          covered: c.covered,
          availableCents: c.availableCents,
          commonCents: c.commonCents,
          full: c.full,
        })),
        cheapestCommon: result.cheapestCommon,
        lines: result.lines.slice(0, 100).map((l) => ({
          label: l.label.slice(0, 500),
          product: l.product ? productView(l.product) : null,
          quantity: l.quantity,
          status: l.status,
          common: l.common,
          cheapestChainId: l.cheapestChainId,
          prices: l.prices
            .slice(0, 30)
            .map((p) => ({ chainId: p.chainId, unitCents: p.unitCents, lineCents: p.lineCents })),
        })),
      },
      candidates: options.slice(0, 15),
      notes: [
        ...(filter.unknown.length ? [`Sin datos de: ${filter.unknown.join(", ")}.`] : []),
        ...(unresolvedFor.size
          ? [`${unresolvedFor.size} sin producto elegido: no se pueden comparar todavía.`]
          : []),
      ].slice(0, 6),
    };
    return {
      output: {
        region: AR_PROVINCES[region.region],
        dataDate: priced.info.date,
        requested: result.lines.length,
        inEveryChain: result.commonLines,
        cheapestForCommonProducts: result.cheapestCommon
          ? {
              chain: chainName(result.cheapestCommon.chainId),
              saves: ars(result.cheapestCommon.savingsCents),
              vs: chainName(result.cheapestCommon.vsChainId),
            }
          : null,
        chains: result.chains.map((c) => ({
          chain: c.chain.name,
          inCommon: ars(c.commonCents),
          has: `${c.covered}/${result.lines.length}`,
          ...(c.full ? { fullList: ars(c.fullCents!) } : {}),
        })),
        fullListCheapest: result.fullCoverage[0] ? chainName(result.fullCoverage[0].chainId) : null,
        withoutProduct: [...unresolvedFor.values()],
        withoutPrice: result.lines.filter((l) => l.status === "no_price").map((l) => l.label),
        ...(filter.unknown.length ? { chainsWithoutData: filter.unknown } : {}),
        instructions: `${RULES} "Cheapest" only for the products in common; a chain missing products is never cheaper for the whole list (fullList exists only where every product is priced). Name what couldn't be compared. ${unresolvedFor.size ? `Items without a product: the options are on screen — ask which one each is; when they choose, ${list ? "link it with shopping.linkItem and compare again" : "compare again with its ean"}. Never choose for them.` : ""}`,
      },
      display: {
        kind: "shopping",
        shopping: payload,
        title:
          list?.name ?? (env.ctx.locale === "es" ? "Comparación de precios" : "Price comparison"),
        key: `shopping:basket:${list?.id ?? "items"}`,
      },
      ...(list ? { target: { type: "list", id: list.id } } : {}),
    };
  },
};

// ── Link a list item ─────────────────────────────────────────────────────────

const linkInput = z
  .object({
    list: z.string().trim().min(1).max(120),
    item: z.string().trim().min(1).max(500).describe("The item's text as it is on the list."),
    itemId: z.uuid().optional().describe("The item's id, when known (screens)."),
    ean: z
      .string()
      .regex(/^\d{8,14}$/)
      .describe("The product the user chose (or a barcode they gave)."),
    quantity: z.number().int().min(1).max(99).optional().describe("How many packages."),
    byBarcode: z
      .boolean()
      .optional()
      .describe("True only if the user gave the barcode themselves."),
  })
  .strict();

export const linkItemTool: ToolDefinition = {
  name: "shopping.linkItem",
  capability: "shopping",
  operation: "linkItem",
  description:
    '"Es la segunda", "esa leche es la que compro": remember which product a list item is (after the user chose it). Only with their choice — never on your own guess.',
  input: linkInput,
  async describe(raw) {
    const q = linkInput.parse(raw);
    return { summary: `Link "${q.item}" to ${q.ean}` };
  },
  async run(raw, env) {
    const q = linkInput.parse(raw);
    const lists = await env.providers.get("lists", env.binding).find(q.list);
    if (lists.length !== 1)
      throw new AppError("NOT_FOUND", `No single list "${q.list}"; ask which.`, {
        recovery: "review",
      });
    const want = fold(q.item);
    const items = lists[0]!.items.filter((i) => !i.checked);
    const item =
      (q.itemId ? items.find((i) => i.id === q.itemId) : undefined) ??
      items.find((i) => fold(i.content) === want) ??
      items.find((i) => fold(i.content).includes(want));
    if (!item)
      throw new AppError("NOT_FOUND", `"${q.item}" isn't an open item of ${lists[0]!.name}.`, {
        recovery: "review",
      });
    const ean = canonicalEan(q.ean);
    if (!ean)
      throw new AppError("VALIDATION_ERROR", "That isn't a valid barcode", { recovery: "review" });
    const product = (await shop(env).data.products([ean])).get(ean);
    if (!product && !q.byBarcode)
      throw new AppError(
        "NOT_FOUND",
        "That product isn't in the published data; never link an invented code.",
        { recovery: "review" },
      );
    await shop(env).link(item.id, ean, q.quantity ?? 1, q.byBarcode ? "barcode" : "confirmed");
    return {
      output: {
        linked: true,
        item: item.content,
        product: product?.name ?? ean,
        instructions: 'Confirm briefly ("Listo, lo recuerdo.").',
      },
      target: { type: "list", id: lists[0]!.id },
    };
  },
};

// ── History ──────────────────────────────────────────────────────────────────

const historyInput = z
  .object({
    ean: z.string().regex(/^\d{8,14}$/),
    days: z.number().int().min(7).max(365).default(90),
    region: regionInput,
  })
  .strict();

export const historyTool: ToolDefinition = {
  name: "shopping.history",
  capability: "shopping",
  operation: "history",
  description:
    '"¿Cuánto aumentó esta leche desde el mes pasado?": a product\'s list price over time per chain, from real published changes. Only products someone linked or watches have history (since then). Not inflation: economy.inflation is a separate reference.',
  input: historyInput,
  async describe(raw) {
    return { summary: `Price history ${historyInput.parse(raw).ean}` };
  },
  async run(raw, env) {
    const q = historyInput.parse(raw);
    const region = await regionFor(env, q.region);
    if (!region.ok) return { output: region.output };
    const ean = canonicalEan(q.ean);
    if (!ean) throw new AppError("VALIDATION_ERROR", "That isn't a valid barcode");
    const to = todayIn(env.ctx.timezone, env.ctx.now);
    const from = addDays(to, -q.days);
    const [series, products] = await Promise.all([
      shop(env).data.history(region.region, ean, from),
      shop(env).data.products([ean]),
    ]);
    const product = products.get(ean) ?? null;
    const changes = series
      .map((s) => ({ chain: s.chain.name, c: priceChange(s.points) }))
      .filter((x) => x.c);
    if (!series.length || !changes.length)
      return {
        output: {
          history: false,
          instructions:
            "There aren't two real observations of this product's price yet (history starts when someone links it to a list or sets an alert). Say so; offer today's prices instead. Never estimate a past price.",
        },
      };
    const payload: Payload = {
      ...empty(region.region, "history", to),
      product: product ? productView(product) : null,
      history: {
        series: series.slice(0, 8).map((s) => ({
          chain: s.chain.name.slice(0, 120),
          points: stepSeries(s.points, from, to).slice(-400),
        })),
        change: changes[0] ? { chain: changes[0].chain.slice(0, 120), ...changes[0].c! } : null,
      },
    };
    return {
      output: {
        product: product?.name ?? ean,
        region: AR_PROVINCES[region.region],
        changes: changes.map((x) => ({
          chain: x.chain,
          from: `${x.c!.from.date} ${ars(x.c!.from.cents)}`,
          to: `${x.c!.to.date} ${ars(x.c!.to.cents)}`,
          percent: x.c!.percent,
        })),
        instructions: `Give the change with its dates and chain. It's this product's list price, not inflation (don't compare with IPC unless asked, and then label each). ${RULES}`,
      },
      display: {
        kind: "shopping",
        shopping: payload,
        title: product?.name ?? ean,
        key: `shopping:history:${ean}:${region.region}`,
      },
    };
  },
};

// ── Region ───────────────────────────────────────────────────────────────────

const setRegionInput = z.object({ place: z.string().trim().min(2).max(80) }).strict();

export const setRegionTool: ToolDefinition = {
  name: "shopping.setRegion",
  capability: "shopping",
  operation: "setRegion",
  description:
    '"Compro en Córdoba", "mi zona es CABA": the province ELISE compares supermarket prices in (saved for next time). Doesn\'t change any other location setting.',
  input: setRegionInput,
  async describe(raw) {
    return { summary: `Shopping region: ${setRegionInput.parse(raw).place}` };
  },
  async run(raw, env) {
    const q = setRegionInput.parse(raw);
    const r = regionFromWords(q.place);
    if (r.kind !== "one")
      return {
        output: {
          saved: false,
          options:
            r.kind === "ambiguous"
              ? r.options.map((x) => AR_PROVINCES[x])
              : Object.values(AR_PROVINCES),
          instructions: "Ask which province exactly.",
        },
      };
    await shop(env).saveRegion(r.region);
    return {
      output: {
        saved: true,
        region: AR_PROVINCES[r.region],
        instructions: "Confirm in a few words.",
      },
    };
  },
};

// ── Alerts ───────────────────────────────────────────────────────────────────

const alertsInput = z
  .object({
    action: z.enum(["create", "list", "delete"]),
    ean: z
      .string()
      .regex(/^\d{8,14}$/)
      .optional(),
    below: z.number().positive().max(50_000_000).optional().describe("Pesos (ARS)."),
    chains: z.array(z.string().trim().min(2).max(40)).max(10).optional(),
    region: regionInput,
    product: z
      .string()
      .trim()
      .max(200)
      .optional()
      .describe("delete: the product's name as listed."),
  })
  .strict();

export const alertsTool: ToolDefinition = {
  name: "shopping.alerts",
  capability: "shopping",
  operation: "alerts",
  description:
    '"Avisame si esta yerba baja de $5.000", "¿qué alertas de precio tengo?", "borrá la alerta de la yerba": price alerts on one product (by ean) in the user\'s province, checked once a day when new prices are published. Notifies once per drop; re-arms when it goes back up.',
  input: alertsInput,
  async describe(raw) {
    return { summary: `Price alerts: ${alertsInput.parse(raw).action}` };
  },
  async run(raw, env) {
    const q = alertsInput.parse(raw);
    const s = shop(env);
    if (q.action === "list") {
      const alerts = await s.alerts.list();
      const payload: Payload = {
        ...empty(alerts[0]?.region ?? "AR-C", "alerts", null),
        regionName: alerts[0] ? AR_PROVINCES[alerts[0].region] : "Argentina",
        alerts: alerts.map((a) => ({
          product: a.productName,
          thresholdCents: a.thresholdCents,
          region: AR_PROVINCES[a.region],
          state: a.state,
          lastBestCents: a.lastBestCents,
          lastBestChain: a.lastBestChain,
          lastQuoteDate: a.lastQuoteDate,
          lastCheck: a.lastCheck,
        })),
      };
      return {
        output: {
          alerts: alerts.map((a) => ({
            product: a.productName,
            below: ars(a.thresholdCents),
            region: AR_PROVINCES[a.region],
            state: a.state,
          })),
        },
        display: {
          kind: "shopping",
          shopping: payload,
          title: env.ctx.locale === "es" ? "Alertas de precio" : "Price alerts",
          key: "shopping:alerts",
        },
      };
    }
    if (q.action === "delete") {
      const want = fold(q.product ?? "");
      const alerts = await s.alerts.list();
      const hit = alerts.filter((a) =>
        q.ean ? a.ean === canonicalEan(q.ean) : want && fold(a.productName).includes(want),
      );
      if (hit.length !== 1)
        return {
          output: {
            deleted: false,
            alerts: alerts.map((a) => a.productName),
            instructions: "Ask which alert.",
          },
        };
      await s.alerts.remove(hit[0]!.id);
      return { output: { deleted: true, product: hit[0]!.productName } };
    }
    if (!q.ean || !q.below)
      return {
        output: {
          created: false,
          instructions:
            "An alert needs the exact product (find it first, the user picks) and a price in pesos.",
        },
      };
    const region = await regionFor(env, q.region);
    if (!region.ok) return { output: region.output };
    const ean = canonicalEan(q.ean);
    const product = ean ? (await s.data.products([ean])).get(ean) : undefined;
    if (!ean || !product)
      return {
        output: {
          created: false,
          instructions: "That product isn't in the published data; find it first.",
        },
      };
    const priced = await s.data.prices(region.region, [ean]);
    const today = priced?.prices.get(ean) ?? [];
    const available = [...new Map(today.map((p) => [p.chain.id, p.chain])).values()];
    const filter = chainFilter(q.chains, available);
    const alert = await s.alerts.create({
      ean,
      productName: product.name,
      region: region.region,
      thresholdCents: Math.round(q.below * 100),
      chains: filter.ids ?? null,
    });
    const best = today
      .filter((p) => !filter.ids || filter.ids.includes(p.chain.id))
      .sort((a, b) => a.listCents - b.listCents)[0];
    return {
      output: {
        created: true,
        product: product.name,
        below: ars(alert.thresholdCents),
        region: AR_PROVINCES[region.region],
        today: best
          ? `${ars(best.listCents)} en ${best.chain.name}`
          : "no price published here today",
        ...(filter.unknown.length ? { chainsWithoutData: filter.unknown } : {}),
        instructions: `Confirm: ELISE checks once a day when new prices are published and notifies once when it drops to or below that price (reference price for the province). ${best && best.listCents <= alert.thresholdCents ? "Today's price is already below: say it will notify after the next publication." : ""}`,
      },
    };
  },
};

export const SHOPPING_TOOLS = [
  findProductTool,
  productPricesTool,
  compareTool,
  linkItemTool,
  historyTool,
  setRegionTool,
  alertsTool,
] as const;

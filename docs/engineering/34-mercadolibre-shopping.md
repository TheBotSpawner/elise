# Mercado Libre first for buying products — report (ADR-112)

Date: 2026-10-22.

**Status:**
- The web-search path is implemented and tested live.
- The official API adapter is implemented and **off**. It is blocked on approval and
  credentials from Mercado Libre.

## 1. Audit (before)

- **How products were found:**
  - `web.search`, for facts;
  - `web.discover` ("buscame publicaciones de…"), which searched, **read listing pages and
    followed item links**. Its own example even said "autos … en Mercado Libre".
  - `web.research`, for comparisons.

  Nothing was specific to Mercado Libre or to country or currency.
- **Problem found:** Mercado Libre's terms forbid robots and scraping. The site also refuses
  non-browser clients, so `web.discover` either failed on it or would have broken those terms.
- **Already available and reused:**
  - the web capability (search with `domains`, open, cache, quotas);
  - `web.discover` for other stores;
  - SEPA (ADR-111) for groceries;
  - `user_preferences.shopping` (province);
  - Surfaces and the executor.

## 2. Official API feasibility (live checks, 2026-10-22 ~22:34 UTC, no credentials)

| Endpoint | Result | Documentation |
|---|---|---|
| `GET /sites/MLA/search?q=…` | 403 `forbidden` | Only documented by `seller_id` / `nickname` / `category`, with a token. **No documented general keyword search.** |
| `GET /sites/MLA` | 403 PolicyAgent | Requires a token. |
| `GET /products/search?site_id=MLA&q=…` | 403 PolicyAgent | Catalog search, documented for sellers (choosing a catalog product). With a token, it may give `buy_box_winner` per product. |
| `GET /items/{id}`, `/items/bulk?ids=` | 403 PolicyAgent | `/items?ids=` is deprecated; migrate to `/items/bulk` **before 25/10/2026** (doc of 10/09/2026). |
| `GET /currencies/ARS` | 403 PolicyAgent | — |
| OAuth | — | `authorization_code` (+PKCE) then `refresh_token`, which **rotates on each use**. No app-only grant documented. |
| Site pages (`www.` / `listado.`) | Error page for non-browser clients (even `robots.txt`) | Terms cl. 7.6 forbid robots and scraping. |

Terms relevant to this use:
- **No scraping** (7.6).
- **No storing content** to build competing services (7.4).
- **Mercado Libre content can't be "confundido ni combinado"** with third parties' content.
- **Apps can be revoked** at any time.

**Verdict:** there is no authorized general price search for a shopping assistant today. The
adapter is ready behind a flag. Enabling it needs Mercado Libre's confirmation (see §8).

## 3. What works today (live, real data)

`scripts/marketplace-smoke.ts` runs ELISE's own web search (OpenAI web search from
`.env.local`) restricted to `mercadolibre.com.ar`, then applies the same filters as
`shopping.offers`.

| Query | Results | Listings kept (never opened) | Notes |
|---|---|---|---|
| "Broadlink RM4 Mini" (model RM4 Mini) | 2–4 | 2 exact | URLs `/up/MLAU…` (user products) |
| "aire acondicionado inverter 3000 frigorias" | 7 | 6 related | Real LG, Hisense, Philco, Gree listings |
| "Samsung Galaxy A55 256GB" | 4+ | several | `/p/MLA…` catalog pages. "Caja abierta" and "Reacondicionado" are flagged as not new. |

These checks led to two fixes:
- `/up/MLAU…` URLs are recognized as listings;
- "nuevo con caja abierta" no longer counts as new.

## 4. Journeys (Spanish, Argentina)

| Say | What ELISE does |
|---|---|
| "Buscame un Broadlink RM4 Mini al mejor precio" | Mercado Libre card: exact matches first, "Precio en la publicación", plus "Buscar en Mercado Libre". Other stores with prices in their own card (`web.discover`). Voice says Mercado Libre prices aren't verified and gives the stores' prices it found. |
| "¿Cuánto está un aire inverter de 3000 frigorías?" | The same, with related listings, never "the cheapest on Mercado Libre". |
| "Tres auriculares inalámbricos por menos de 100 lucas" | `maxPrice` = ARS 100.000. The search link carries `_PriceRange_0-100000`. |
| "Solo Mercado Libre" / "No uses Mercado Libre" | `only`: no other stores. `avoid`: Mercado Libre isn't queried at all. |
| "Usá siempre solo Mercado Libre" | Saved preference (`shopping.marketplacePreference`), with no redeploy |
| "¿Conviene en Mercado Libre o en otra tienda?" | Both, reported apart, with each figure's source |
| Groceries ("leche", "lista del súper") | SEPA (ADR-111), not this |

## 5. Architecture and files

**Core:** `src/core/shopping/marketplace.ts`
- country sites (MLA, MLM, MLB, MLC, MCO, MLU, MPE) and `buyingCountry`;
- `parseAmount` ("lucas", "palo", "mil", "k") and slang ("celu", "tele", "aire");
- `matchOffer` (exact, related, accessory) and `conditionOf`;
- `safeMarketplaceUrl` (official host, https, no tracking, lookalikes rejected), `isMarketplaceHost`
  and `marketplaceSearchUrl`;
- the `Offer` contract with its `evidence`, plus `rankOffers`, `dedupeOffers` and `LISTING_ID`;
- the `MarketplaceApi` port.

**Infrastructure:** `src/infrastructure/shopping/mercadolibre.ts`
- off by default; documented endpoints only, validated with zod;
- rotating token stored encrypted;
- circuit breaker; logs without user data.

**Tool:** `src/core/tools/marketplace.ts` (`shopping.offers`, `shopping.marketplacePreference`)

**Changed:**
- `web-service.ts`: never opens Mercado Libre pages;
- `web.ts`: `discover` gets `exclude`, and its description routes product purchases to
  `shopping.offers`;
- the capability registry;
- tool selection (`SHOPPING_SIGNAL`) and model guidance;
- the `ShoppingCapability` (preference rows are now merged, never overwritten);
- the `product_offers` Surface (registry, view `features/workspace/product-offers-view.tsx`) and
  i18n;
- `server-env`, `.env.example`;
- migration `20261116000065_app_credentials.sql`.

## 6. Configuration

| Variable | Default | Meaning |
|---|---|---|
| `MERCADOLIBRE_API_ENABLED` | `false` | Use the official API (only after approval) |
| `MERCADOLIBRE_CLIENT_ID` / `MERCADOLIBRE_CLIENT_SECRET` | — | ELISE's application in DevCenter |
| `MERCADOLIBRE_REFRESH_TOKEN` | — | First refresh token, from the one-time OAuth of ELISE's own account. Later ones live encrypted in `app_credentials`. |

All of them are server-only, never sent to the renderer, the browser or the model.

## 7. Tests

| Command | Result |
|---|---|
| `npx vitest run tests/unit/shopping/marketplace.test.ts` | 16 passed. Spec cases 1–12 on synthetic fixtures, plus the real URL shapes seen live. |
| `npx vitest run tests/unit/shopping/web-guard.test.ts` | 1 passed: no Mercado Libre page is ever fetched. |
| Live smoke: `npx --yes tsx@4.19.2 --conditions=react-server --env-file=.env.local --tsconfig tsconfig.json scripts/marketplace-smoke.ts "<producto>" "<modelo>"` | Real listings (see §3) |
| Official API | **Not tested live**: there are no credentials, and every call is 403 without them. Not declared working. |

## 8. Manual steps (to enable the official API later)

1. In https://developers.mercadolibre.com.ar/devcenter, create the application "ELISE". Scopes:
   read only. Set a redirect URI on ELISE's domain.
2. **Ask Mercado Libre (Developer Partner Program / soporte de integradores)** in writing
   whether a personal shopping assistant may use `/products/search` and `/products/{id}`
   (`buy_box_winner`), and `/items/bulk`, to show prices of third-party listings with links.
   Ask also whether a general keyword listing search is available for this use. Do not enable
   without a yes.
3. Run the OAuth once with ELISE's own account to get the first refresh token. Set the three
   variables in Vercel (Production), plus `MERCADOLIBRE_API_ENABLED=true`.
4. Apply migration 065 (`npx supabase db push`) and redeploy.

## 9. Limitations

- No Mercado Libre prices until the API is approved. Listings come from the web search index and
  may be incomplete or not the newest.
- No seller reputation, installments or shipping cost without the API. They are never inferred.
- The catalog API (if approved) gives catalog products, not every listing. Mercado Libre's
  results must stay apart from other stores'.
- There are no runtime feature flags in ELISE. The global API switch is an environment variable
  and needs a redeploy; the per-person marketplace choice doesn't.
- No buying or checkout inside ELISE, by design.

## 10. Next steps

- **Blocked on Mercado Libre:** approval, credentials, and confirming that `/products/search`
  may be used this way.
- **Safe now:**
  - USD prices with an explicit `economy.exchangeRates` conversion when a store lists in
    dollars;
  - remembering the product being discussed across turns (today it comes from the conversation
    itself).

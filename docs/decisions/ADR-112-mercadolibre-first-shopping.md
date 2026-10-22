# ADR-112: Mercado Libre first for buying products in Argentina

**Status:** Accepted (2026-10-22). Builds on ADR-015 (Web), ADR-028 (items) and ADR-111
(groceries come from SEPA).

## Context

People in Argentina buy electronics and appliances mostly on Mercado Libre. ELISE should look
there first, but only show what is legitimately verifiable.

Checked live and in the official documentation on 2026-10-22:

- **No access without a token.** Every API endpoint answers 403 `PA_UNAUTHORIZED_RESULT_FROM_POLICIES`
  without one, including `/sites/MLA`, `/sites/MLA/search?q=`, `/products/search`, `/items/{id}`,
  `/items/bulk` and `/currencies/ARS`.
- **No general keyword search of listings is documented.** `/sites/$SITE_ID/search` is only
  documented by `seller_id`, `nickname` or `category`, always with a token.
  - `/products/search?q=` searches the **catalog**, and is documented for sellers choosing a
    catalog product to list against.
  - `/users/{id}/items/search` returns one seller's own listings.
- **`/items?ids=` is being deprecated.** The doc updated on 10/09/2026 says to migrate to
  `/items/bulk?ids=` before 25/10/2026.
- **Only user OAuth is documented** (`authorization_code` + PKCE, then `refresh_token`, which
  rotates on every use). No app-only grant is documented.
- **Developer terms:**
  - cl. 7.6: no robots, harvesters, spiders or scraping of the site;
  - cl. 7.4: storing content to build competing services is forbidden;
  - Mercado Libre's content shown in an application "no podrá confundirse ni combinarse con el
    contenido de terceros".
- **The site itself refuses non-browser clients.** Even `robots.txt` returns an error page.

## Decision

1. **`shopping.offers`** is the tool for products to buy. Groceries stay with SEPA (ADR-111).
   - **Country:** what the person says, else their saved shopping province (Argentina), else an
     Argentine timezone. Never the language of the question, never an IP. With no country, it
     makes no Mercado Libre guess and asks.
   - **Mode:** `prefer` (default), `only` or `avoid`, per request. A lasting choice is saved with
     `shopping.marketplacePreference` (`user_preferences.shopping.marketplace`), and changes with
     no redeploy.
2. **The official API adapter is off by default** (`MERCADOLIBRE_API_ENABLED=false`).
   - It uses only documented endpoints: `/products/search?q=` (catalog), `/products/{id}`
     (`buy_box_winner` price) and `/items/bulk`.
   - It authenticates as ELISE's own application account, never a buyer's. The rotating refresh
     token is stored encrypted in `app_credentials` (migration 065, service role only).
   - It stops for 10 minutes on 401/403 and 1 minute on 429.
   - **Mercado Libre must confirm, in writing, that this use is allowed before it is enabled.**
3. **Without the API (today), nothing is invented:**
   - ELISE's existing web search, restricted to the country's Mercado Libre domain, gives
     listings as **title and link only, with no price**. ELISE never opens their pages.
   - Mercado Libre's own search (`listado.mercadolibre.com.ar/<palabras>`) is always shown as a
     labeled link, never as a listing.
4. **ELISE never reads Mercado Libre pages.** `webCapability.open` refuses every Mercado Libre
   domain with "the site's terms don't allow automated reading". This covers `web.open`,
   `web.discover` and `web.research`.
5. **Other stores are shown apart.** They come from `web.discover` (with `exclude` for Mercado
   Libre domains) in their own Surface, never merged into Mercado Libre's ranking. They are
   included when the person asks, when Mercado Libre is avoided or unavailable, or when it has no
   verified price.
6. **Honest matching and ranking:**
   - Exact model first: "RM4 Mini" = "RM-4 mini" ≠ "RM4 Pro".
   - Accessories and parts are flagged; used, refurbished and open-box items are not new.
   - Priced offers rank above unpriced ones, then the lowest price wins.
   - Budgets in Argentine slang are parsed ("100 lucas" = 100.000, "1 palo" = 1.000.000) and
     never converted between currencies without a stated rate.
   - Shipping, installments and promotions are shown only as the source states them.
7. **UI and voice:**
   - A `product_offers` Surface (cards with source, evidence level, price only if verified, "Ver
     publicación", and "Buscar en Mercado Libre") on Web and Desktop.
   - Voice gives two or three options with price and difference when verified. Otherwise it
     says plainly that the prices aren't verified and what is on screen.

## Consequences

- Until Mercado Libre approves the use, ELISE shows real Mercado Libre listings (as links) but no
  Mercado Libre prices. Prices come from other stores' pages, through the existing item reading.
- Results depend on the web search index. A brand-new listing may not appear; the search link
  covers that.
- If the API is enabled, its results stay in their own Surface (terms), and the conditions above
  still apply.

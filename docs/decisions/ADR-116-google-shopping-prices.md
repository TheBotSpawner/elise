# ADR-116: Prices for products to buy from Google Shopping (SerpApi), tied to listings only by identity

**Status:** Accepted (2026-10-23). Extends ADR-112 (Mercado Libre first). Off by default.

## Context

`shopping.offers` shows Mercado Libre listings found by web search with no price. The official
API is blocked (403 without an approved application, ADR-112), and ELISE never reads Mercado
Libre's pages (terms cl. 7.6). People still need a price.

SerpApi's Google Shopping API returns, for `gl=ar`, structured results:
- `title`, `price`, `extracted_price` and `source` (the store);
- `link` (the offer, when Google gives it), `product_link` (Google's page) and `thumbnail`.

It is a paid third-party API. Its free plan has 250 searches a month (to confirm at
serpapi.com/pricing). It is not a permission from Mercado Libre.

**Not yet verified live:** no SerpApi key exists in this project. Whether Argentine results link
individual Mercado Libre listings is unknown until a real query is run (report §Live).

## Decision

1. **`PriceIndex`** (core) is implemented by `infrastructure/shopping/google-shopping.ts`
   (SerpApi, server-only key).
   - **Flags:**
     - `SHOPPING_GOOGLE_SHOPPING_ENABLED=false` (default);
     - `SERPAPI_API_KEY`;
     - `SHOPPING_GOOGLE_SHOPPING_IMAGES=false` (default);
     - `SHOPPING_GOOGLE_SHOPPING_MONTHLY_LIMIT=200`.
   - **Request:** one call per `shopping.offers` with `gl=ar`, `hl=es`, location Buenos Aires,
     and a 6 s timeout.
   - **Cache:** 30 minutes per query.
   - **Pauses:** 10 minutes after a 401/403, 1 minute after a 429.
   - **Budget:** a monthly cap, counted per server instance.
   - **Failure:** the answer degrades to today's behaviour, with a note.
2. **Only prices ELISE can stand behind** (`parseShoppingResults`):
   - a total in the site's currency;
   - never an installment ("12 x $"), dollars, zero, a pack, or an accessory.
3. **A price reaches a Mercado Libre listing only by identity** (`attachPrices`): the result's
   own link must be that listing.
   - The listing is identified by kind and id: item `MLA-…`, catalog product `/p/MLA…`, or user
     product `/up/MLAU…`. Different kinds are never equal.
   - A similar title is never enough.
   - **A result naming Mercado Libre as the store without a listing link** is shown in its own
     section: "Precio de referencia · Google Shopping · tienda: Mercado Libre". It never goes
     into a listing's card.
   - **Other stores** are shown in "Otras tiendas · Google Shopping", apart from Mercado Libre's
     block. They are left out under "solo Mercado Libre".
4. **Models.**
   - `matchOffer` matches whole tokens, so "RM4 Mini" ≠ "RM4C Mini". A code like "5g" no longer
     swallows the next number.
   - "No es exactamente el modelo pedido" is shown only when an exact model was asked for.
5. **Card and voice.**
   - The price is shown large as `AR$ …`, with "Precio consultado en Google Shopping · hh:mm",
     or "Precio oficial de Mercado Libre" from the API.
   - One compact line counts the listings without a price, instead of a sentence per card.
   - Each offer has a product image or a neutral placeholder.
   - Voice says "según Google Shopping" and that the price may have changed. It gives two or
     three options, never URLs.
6. **Images:** off until the licence to display the stores' thumbnails is confirmed. Even then,
   only Google's image hosts are allowed.

## Consequences

- Nothing changes until the owner adds a key and enables the flag after a positive live check.
- If live results don't link Mercado Libre listings, the cards keep showing links without
  prices. The references and other stores' prices are then the useful part, clearly labelled.
- Cost: one SerpApi search per product question (cached for 30 minutes).

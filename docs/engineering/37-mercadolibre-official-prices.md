# Mercado Libre official prices, local OAuth, SerpApi removed — report (ADR-116)

Date: 2026-10-23. Local development against the project's Supabase. Nothing deployed.

## 1. Connecting ELISE's application account

**Prerequisites:**
- **Redirect URI** registered in Mercado Libre Developers:
  `https://elise-lime.vercel.app/api/integrations/mercadolibre/callback`. No route exists there:
  the browser shows "404" with the code in its address bar, and that address is passed to
  `finish`.
- **`.env.local` variables:**
  - `MERCADOLIBRE_API_ENABLED`;
  - `MERCADOLIBRE_CLIENT_ID`;
  - `MERCADOLIBRE_CLIENT_SECRET`;
  - `MERCADOLIBRE_REDIRECT_URI`;
  - `MERCADOLIBRE_REFRESH_TOKEN`, empty (bootstrap only).

**Steps:**
```
npx --yes tsx@4.19.2 --conditions=react-server --env-file=.env.local --tsconfig tsconfig.json scripts/mercadolibre-connect.ts connect
… finish "<address the browser returned to>"
… status | probe <MLA…> [words] | disconnect
```

**Result:** connected account `LJM_STORE` (id 461450644). The refresh token is stored encrypted
in `app_credentials`. `/users/me` answered 200.

## 2. Real calls (authenticated, 2026-10-23 ~17:55 UTC)

| Call | HTTP | What it returned |
| --- | --- | --- |
| `GET /items/MLA1528226212` (control listing, another seller) | **403** | `access_denied`, "Access to the requested resource is forbidden" |
| `GET /items/MLA1528226212/sale_price?context=channel_marketplace` | **403** | `access_denied` |
| `GET /items/MLA1528226212/prices` | **403** | `access_denied` |
| `GET /users/461450644/items/search` (own listings) | 200 | 7 listings |
| `GET /items/{own id}` and `/sale_price` | 200 | `amount` in ARS, `regular_amount` |
| `GET /products/search?q=Broadlink RM4C Mini` | 200 | 10 catalog products |
| `GET /products/MLA34913806` | 200 | name, 10 photos (`http2.mlstatic.com`); `permalink` empty; `buy_box_winner` null |
| `GET /products/MLA34913806/items` | 200 | listings with `item_id`, `price`, `currency_id`, `condition`, `shipping.free_shipping`, `original_price` |

**Conclusion:**
- This application cannot read other sellers' listings by id, nor their prices. That is
  demonstrated, not worked around.
- It can read the catalog and the listings of a catalog product with their official price.

**`shopping.offers` with the live API:**

| Request | Card |
| --- | --- |
| "Buscame un Broadlink RM4C Mini en Mercado Libre" | 1 official offer: "Control Remoto BroadLink Rm4c Mini", **AR$ 369.999,99**, new, free shipping, official photo, exact model, its own listing link |
| "¿Cuánto sale este producto?" + `MLA-1528226212` | The link without price; note "Mercado Libre no autorizó…"; the model is told `HTTP 403 on /items/:id` |
| "solo Mercado Libre" | Same official offer, no other stores |
| "Broadlink RM4 Mini" | AR$ 166.099, which is a different model from RM4C (`related` when RM4C was asked) |
| "aire acondicionado inverter 3000 frigorías" | The catalog returned 7525-frigoría units and brackets: shown as related, never as the asked size |

**Latency:**
- each `/products/search` plus products ≈ 2.4–3.3 s;
- a single item call ≈ 0.2–0.5 s (the first one includes the token refresh ≈ 2 s).

## 3. What changed

| File | Change |
| --- | --- |
| `src/infrastructure/shopping/mercadolibre.ts` | OAuth: consent URL with state and PKCE, `completeAuthorization`, `connectionStatus`, `disconnect`. Refresh: single-flight, re-read on `invalid_grant`, rotated token saved encrypted as JSON. Catalog search → `/products/{id}/items`, cheapest listings with official price. Exact listings: `/items/{id}` + `/sale_price` (works for own listings; 403 for others). A 401 pauses the API for 10 min and a 429 for 1 min; a 403 refuses that resource only. `call()` gives status, latency and body without the token. |
| `src/core/shopping/marketplace.ts` | `listingKey` (item / `p:` / `up:` never equal); `MarketplaceApi.listings`; whole-token model matching (RM4 ≠ RM4C). |
| `src/core/tools/marketplace.ts` | Official catalog first. A pasted link checks that exact listing. Web search (links, no price) only when there are no official results. The model gets `officialApi: refused (HTTP …)`. |
| `src/features/workspace/product-offers-view.tsx` | Price `AR$` with "Precio oficial de Mercado Libre · hh:mm", photo or placeholder, one line for unpriced listings, model flag only when asked. |
| `scripts/mercadolibre-connect.ts` | `connect` / `finish` / `status` / `probe` / `disconnect`. |
| `src/config/server-env.ts`, `.env.example` | `MERCADOLIBRE_REDIRECT_URI`; SerpApi variables removed. |

**Removed:**
- `src/infrastructure/shopping/google-shopping.ts`;
- `src/core/shopping/price-reference.ts` and its test;
- `priceIndex`, the `references` and `priceSource` payload fields, the card's reference
  sections and their strings;
- the old ADR-116 and report 37 (SerpApi).

## 4. Tests

| File | Covers |
| --- | --- |
| `tests/unit/shopping/mercadolibre-oauth.test.ts` (7) | Consent URL (exact redirect, single-use state, S256, no secret); wrong state, wrong address and denied access refused before any request; code exchange with the verifier and encrypted storage; no token in status or logs; rotation with concurrent calls refreshing once; `invalid_grant` re-read; 403 refuses that resource without pausing; disconnect. |
| `tests/unit/shopping/marketplace.test.ts` | Listing identity; RM4 ≠ RM4C; official catalog first with the exact model leading; pasted link checked exactly; 403 degrades to links with the reason; "solo Mercado Libre"; "no uses Mercado Libre". |

Isolation between users doesn't apply: this is ELISE's own application account, not a user's
connection. It is server-only and admin-run.

## 5. Limits and next steps

- **Third-party listings (403):** prices come only through the catalog (`/products/{id}/items`).
  A listing outside the catalog, or a pasted link to another seller's listing, has no price. To
  read listings by id, Mercado Libre would have to grant the application that access.
- **Catalog relevance:** the catalog search is Mercado Libre's. Results that aren't the asked
  model or size are flagged, never presented as it.
- **The web connect flow** (a production route with an admin session) isn't built: the local
  command covers the owner's one-time connection. In production, `MERCADOLIBRE_API_ENABLED=true`
  plus the same client id and secret read the token from `app_credentials`, which is the same
  database.

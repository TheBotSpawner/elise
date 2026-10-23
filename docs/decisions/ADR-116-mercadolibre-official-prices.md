# ADR-116: Mercado Libre prices only from its official API, by exact listing (no SerpApi)

**Status:** Accepted (2026-10-23). Extends ADR-112. Replaces an uncommitted-to-production design
that used SerpApi / Google Shopping, which is removed.

## Context

`shopping.offers` showed Mercado Libre listings found by web search with no price.

A SerpApi (Google Shopping) adapter was built and never enabled. The owner decided against it:
- it is an extra paid dependency;
- it never was a permission from Mercado Libre.

The owner created a Mercado Libre Developers application ("ELISE"), and has its Client ID and
Client Secret.

Mercado Libre's documentation says:
- authorization is OAuth `authorization_code`, with optional PKCE;
- the access token lasts 6 hours;
- the refresh token is single-use, and only the latest one is valid;
- `/items/{id}/sale_price?context=channel_marketplace` gives a listing's winning price
  (`amount`, `regular_amount`, `currency_id`);
- an item's own `price` field is being replaced by the price endpoints;
- promotion metadata goes only to the listing's owner.

Whether a non-owner token can read other sellers' listings and prices isn't stated. It is
settled by a real call (report 37).

## Decision

1. **No SerpApi, no Google Shopping provider.** The adapter, its variables, payload fields,
   card sections, strings and tests are removed. Google APIs used for other things (Maps,
   Routes, Calendar, Gmail…) are untouched.
2. **Official prices only for exactly identified listings.**
   - The listings come from:
     - ELISE's existing web search, restricted to Mercado Libre's domain: links only, pages
       never read;
     - or a link the user pastes.
   - Each one's identity comes from its URL (`listingKey`): item `MLA…`, catalog product
     `/p/MLA…`, user product `/up/MLAU…`. Different kinds are never equal.
   - The API is asked for that exact listing:
     - `/items/{id}` for the title, link, condition and photos;
     - `/items/{id}/sale_price` for the price;
     - `/products/{id}` (`buy_box_winner`) for catalog products.
   - A price is never moved between listings or matched by title.
   - When the web search finds nothing, the catalog search `/products/search` is tried.
3. **ELISE's application account.**
   - Connected once with `scripts/mercadolibre-connect.ts`, in two steps:
     - `connect` creates a 256-bit single-use `state` and a PKCE S256 verifier, kept encrypted in
       the OS temp folder for 10 minutes;
     - `finish <returned URL>` checks the redirect URI and the state, then exchanges the code
       server-side with the secret and the verifier.
   - The refresh token is stored encrypted in `app_credentials` (migration 065), as JSON with the
     account's id and nickname. A bare token from older rows is still read.
   - **Refresh:** one at a time per instance. On `invalid_grant` the stored token is re-read once
     (another instance rotated it) and retried.
   - `MERCADOLIBRE_REFRESH_TOKEN` is a bootstrap only.
   - Commands: `status`, `disconnect`, `probe <id> [words]`.
   - Nothing returned or logged contains a token.
4. **Refusals are said, not worked around.**
   - **401/403** pause the API for 10 minutes; **429** for 1 minute.
   - The card keeps the links, with "Mercado Libre no autorizó a ELISE a consultar estas
     publicaciones".
   - The model gets the HTTP status and endpoint, and says it has no price.
5. **Card and voice.**
   - The price is shown large as `AR$`, with "Precio oficial de Mercado Libre · hh:mm".
   - Photos come only from `http2.mlstatic.com`; otherwise a placeholder.
   - One line counts the listings without a price.
   - Exact-model flags appear only when a model was asked for (RM4 ≠ RM4C).
   - Voice gives two or three verified options. Without prices it says so briefly and never
     reads links.

## Consequences

- With the account connected and the API answering, listings show their real current price.
- If Mercado Libre refuses third-party listings for this application, the refusal is shown
  and prices stay off. No other source is used.
- `MERCADOLIBRE_REDIRECT_URI` must match the registered value exactly.

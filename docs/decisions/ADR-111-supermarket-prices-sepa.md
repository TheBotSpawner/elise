# ADR-111: Supermarket prices from SEPA, natively

**Status:** Accepted (2026-10-22). Builds on ADR-051 (Lists) and ADR-094 (public economic
data).

## Context

People ask ELISE "¿dónde me conviene comprar la lista?" and "¿cuánto sale esta leche?". Two
sources were assessed live on 2026-10-22:

- **Community API (superprecios-claros).** The documented host returns HTTP 404 "Application not
  found". The last commit was on 2026-05-21, and the author reports the government WAF blocking
  its cloud IPs. The API never offered search by name either. **Not usable.**
- **Official SEPA dataset** (Secretaría de Comercio, CC-BY 4.0). It is live, with a new ZIP
  every weekday: about 330 MB, 12.25 M rows (one per product per branch), and branch addresses
  and provinces. It works from an Argentine connection.

There was no existing catalog in ELISE.

## Decision

1. **ELISE processes SEPA itself, bounded.** A streaming processor keeps only rows whose code is a
   real barcode (`productos_ean = 1`, GTIN check digit). It aggregates per product × banner ×
   province:
   - median list price, lowest price, and number of branches;
   - general promotion (promo 1), counted only when most branches have it;
   - conditional promotion (promo 2), kept as text only.

   It drops companies whose data is older than 4 days; some republish files from 2021. One
   measured day gives 60,899 products and 1.1 M aggregated prices.
2. **Storage by shape.**
   - Each province's prices of the day go to Storage as one compressed JSON (8.1 MB for all 24
     provinces), validated when read and cached per server instance.
   - The catalog (~61k rows, folded search text) goes to Postgres.
   - History goes to Postgres too, but only for products someone links or watches, delta-only.
   - All of it is public data, shared and read-only for members. Links, the saved province and
     alerts are private under RLS (migration 064).
3. **Ingestion is off by default.**
   - A Trigger.dev task runs on weekdays at 11:00 and 17:00 Buenos Aires time, and does nothing
     unless `SHOPPING_INGEST_ENABLED=true`. It skips a day that was already ingested.
   - `scripts/shopping-ingest.ts` runs the same code by hand, for the first load or when the
     cloud is blocked.
   - Downloads come only from `datos.produccion.gob.ar`, over https, with redirects checked.
4. **Names never become products by themselves.**
   - `rankCandidates` drops products missing a variant the person named ("descremada") or with a
     different size. It flags extra variants ("deslactosada", "con poleo") and prefers products
     sold in more chains in the province.
   - The person picks. The pick is stored beside the list item (`list_item_products`), and the
     list text is untouched.
   - A barcode is exact.
5. **Deterministic basket.** All amounts are integer cents. List prices only; promotions are
   never assumed. Three totals:
   - **common:** the products every compared chain has; "cheapest" applies only to these;
   - **available:** what each chain has;
   - **full:** only where every line is priced.
6. **Region is a province.** It comes from what the person says now, or from their saved
   preference (`user_preferences.shopping`), and is never inferred from the timezone. "AMBA" and
   "Buenos Aires" are asked, because city and province prices differ. Copy always says "precios de
   referencia en <provincia>" with the data date.
7. **Alerts.** Programados only runs time-based actions (`morning_brief`), so price alerts are
   checked by the ingestion itself, right after fresh data arrives.
   - Each alert fires once per crossing: a compare-and-set on its state, plus a notification that
     is unique per crossing.
   - It re-arms above the threshold.
   - Stale or missing data never fires.
   - There is no separate polling loop.
8. **Surfaces and tools.** The `shopping.*` tools are `findProduct`, `productPrices`, `compare`,
   `linkItem`, `history`, `setRegion` and `alerts`. They render a `shopping` Surface (product,
   basket, history, choices, alerts). Listas' "Comparar precios" calls the same tools.

## Consequences

- The feature works only after the first ingestion. Until then, tools and Listas say the data
  isn't loaded, and never use web prices instead.
- A banner's price is a provincial median, not a store quote. Branch-level comparison would need
  per-branch storage (~12 M rows/day) and is out of scope.
- History starts when a product is first linked or watched. There is no back-fill.
- Risk: the government WAF may block Trigger.dev's IPs, as it did Railway's. The manual script
  from an Argentine connection is the fallback. The next step is a proxy or a small worker in
  Argentina, if needed.

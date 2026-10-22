# Supermarket prices (SEPA) — implementation report (ADR-111)

Date: 2026-10-22. Status: implemented and tested against a real SEPA day. **Not enabled in
production yet**: it needs migration 064 and the first ingestion (see "Manual steps").

## 1. Initial audit

**Reused:**
- Listas (`lists`, `list_items`, the `lists.*` tools and the Lists workspace);
- the tool executor (`runUserTool` runs the same tool for a button as for chat);
- the capability registry and tool-selection signals;
- Live Workspace Surfaces (a new `shopping` type);
- `user_preferences`, for the province;
- `notifications`, for alerts;
- Supabase Storage;
- the Trigger.dev schedules;
- `fflate`, already a dependency.

**Missing:**
- any product catalog or price source;
- a list "type" (any list can be compared; the action appears for lists with open items);
- conditional watches in Programados (it only has the time-based `morning_brief`);
- a shopping region.

## 2. Providers assessed (live, 2026-10-22, ~17:30 ART)

| Provider | Check | Result |
|---|---|---|
| A. `superprecios-claros.up.railway.app` | `GET /v1/health`, `GET /v1/manifest` | **HTTP 404 "Application not found"** (Railway). The repo's last commit was 2026-05-21; its author documented the government WAF blocking cloud IPs. No search by name (it was on their roadmap). Discarded. |
| B. Official SEPA (`datos.produccion.gob.ar`, CKAN `package_show?id=sepa-precios`) | CKAN metadata, then the Thursday file downloaded | **Live.** CC-BY 4.0. Thursday 2026-10-22 file: 330,148,581 bytes, HTTP 200 in 185 s from Argentina. 19 company ZIPs, 12,254,915 rows. **Selected.** |
| C. Existing ELISE catalog | Repository audit | None. |
| Precios Claros website | Home 200, no robots.txt | Its backend isn't a published API with terms. **Not used** (would need the agency's OK). |

**Real data facts that shaped the code:**
- `productos_ean` is a flag (1 = the code is a barcode).
- Provinces come as ISO codes (`AR-B`).
- Files arrive in any order inside each company ZIP.
- Some companies republish old data (ChangoMas 2021-04-03, Unicoop 2025-06-11), so they are
  dropped by date.
- Carrefour publishes banners as "Market", "Express" and "Maxi", now shown as "Carrefour …".

Attribution is shown on every card: "Fuente: SEPA, Secretaría de Comercio (CC BY 4.0)", plus the
note that prices are indicative and say nothing about stock.

## 3. User journeys (proven against the real day in `live-smoke.test.ts`)

All of these need the province (asked once, then saved), and data loaded.

| Utterance | What happens | Where it shows |
|---|---|---|
| "¿Cuánto sale la leche entera 1 L?" | `shopping.findProduct` returns real options, best first: sold in the province, in more chains, without extra variants. The person picks. Real output in CABA: "LECHE UAT ENTERA BULNEZ X 1L $1.790", … | Chat, voice, "shopping" Surface (choices) |
| A barcode / "esa, la primera" | Exact product: price per banner, price per liter or kilo, promotions apart | Surface (product) |
| "Compará mi lista del súper" / "…entre Día, Carrefour y Coto" | `shopping.compare`: common, available and full totals. Lines without a product get options to pick from. | Surface (basket); Listas › ⋯ › **Comparar precios** |
| "Tengo que comprar yerba, aceite y dos leches" | Each line gets options first; once the products are picked, it compares | Surface |
| "Esa leche es la que compro" | `shopping.linkItem` remembers the product next to the list item, editable in Listas | Listas dialog |
| "¿Cuánto aumentó desde el mes pasado?" | `shopping.history`: real changes only. History starts when a product is linked or watched. | Surface (step chart) |
| "Avisame si esta yerba baja de $5.000" | `shopping.alerts`: checked after each daily ingestion; one notification per crossing | Notifications; "¿qué alertas tengo?" in a Surface |
| "¿Qué parte de mi lista no se pudo comparar?" | `withoutProduct` / `withoutPrice` in the compare output, shown on the card | Surface |

Real basket in CABA (leche ×2, yerba 1 kg, aceite girasol 1,5 L, data of 2026-10-22):
- Only the oil was sold by all 9 banners, so "cheapest for what's in common" was Carrefour Maxi.
- Only Hipermercado Carrefour and Carrefour Market had the full list ($14.944 / $14.935).

ELISE says exactly that, never "Día is cheaper" for a list Día doesn't fully carry.

## 4. Architecture

```
SEPA CKAN (official host only) ──► ingestSepa (Trigger.dev, off by default │ scripts/shopping-ingest.ts)
   stream ZIP → aggregateSepaDay (sepa.ts) → buildSnapshots (snapshot.ts)
      ├─ Storage shopping-prices/current/AR-*.json.gz   (one per province, ~8 MB in all)
      ├─ shopping_products  (catalog, folded search text)
      ├─ shopping_price_history (tracked products only, delta-only)
      └─ checkPriceAlerts → notifications
ShoppingData (store.ts: catalog/history in Postgres, snapshots cached 30 min per instance)
ShoppingCapability (shopping-service.ts: + province, list links, alerts under RLS)
shopping.* tools (core/tools/shopping.ts) ── chat / voice / Listas dialog
core/shopping/model.ts: regions, barcodes, sizes, matching, compareBasket, stepSeries, evaluateAlert
```

- **Privacy:** lists never leave ELISE. Prices are looked up by barcode in ELISE's own copy, and
  no external API receives user data.
- **Region resolution:** what the person says now, else their saved province, else a single
  question. It is never the timezone, and Buenos Aires is never the default.

## 5. Database

Migration `20261115000064_shopping_prices.sql`:
- `shopping_products`, `shopping_ingestions` and `shopping_price_history` are public: members
  can select, only the service role writes.
- `list_item_products` is workspace-scoped. The `with check` requires the item to belong to the
  same workspace.
- `shopping_price_alerts` belong to one user.
- A unique index makes each crossing notify once.
- A private `shopping-prices` bucket.
- The `shopping` capability is registered.

There is no backfill.

| Variable | Default | Effect |
|---|---|---|
| `SHOPPING_INGEST_ENABLED` | unset (off) | `"true"` lets the scheduled task run the daily ingestion |

## 6. Cost projection (estimates, per month)

| Item | Assumption | Estimate |
|---|---|---|
| Download | 1 × 330 MB per weekday, from the government | $0 (free egress for us) |
| Trigger.dev compute | `large-1x`, about 5 min per weekday, plus a second run that skips in seconds | About $2–4/month, from Trigger.dev's per-second pricing. Measured locally: 57–82 s to parse, about 2.1–2.5 GB peak RSS. **Unverified on Trigger.dev**: its download speed and the WAF are unknown. |
| Storage | 8.1 MB overwritten daily | Negligible |
| Postgres | Catalog of about 61k rows (~15–30 MB with index); history grows only with tracked products × chains × changes | Small. Unbounded only with heavy use of alerts and links. |
| Reads | ≤1 MB province snapshot per server instance every 30 min | Negligible |

**Unknown:** whether the government WAF lets Trigger.dev download. If not, the owner runs the
manual script, or a small proxy in Argentina is needed (a decision for later).

## 7. Tests

| Command | Result |
|---|---|
| `npx vitest run tests/unit/shopping` | 30 passed (model, SEPA parser on a synthetic official-layout ZIP, tools) |
| `npx vitest run tests/integration/shopping.test.ts` | 3 passed (RLS on Postgres/PGlite) |
| Live smoke: `SEPA_SMOKE_DIR=<dir> npx vitest run tests/unit/shopping/live-smoke.test.ts` | **Passed on the real 2026-10-22 file.** Skipped when the variable is unset (never counted as passing on fixtures). |
| Measurement: `npx --yes tsx@4.19.2 --tsconfig tsconfig.json scripts/sepa-measure.ts <zip> [dir]` | 60,899 products, 1,098,109 prices, 21 banners, 8.1 MB of snapshots |
| Full gate (format, lint, typecheck, test, build) and Desktop package + smoke | See the session summary |

**Not run:** the ingestion against a real Supabase (it needs migration 064 applied, which is
your call), and the Trigger.dev task in the cloud.

## 8. Manual steps for Leonardo

1. Apply the migrations: `npx supabase db push`. This applies 062, 063 and 064.
2. First load, from your PC in Argentina:
   `npx --yes tsx@4.19.2 --conditions=react-server --env-file=.env.local --tsconfig tsconfig.json scripts/shopping-ingest.ts`
   - It needs `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in `.env.local`, and
     about 3–5 minutes.
   - It prints the stats.
3. Optional, for daily updates: in Trigger.dev (Production), set `SHOPPING_INGEST_ENABLED=true`
   and deploy the tasks.
   - Check the first run in the Trigger.dev dashboard.
   - If the download fails with 403 (WAF), keep running step 2 by hand, and tell me to set up a
     proxy.
4. Redeploy the web (Vercel) and publish Desktop for the new UI.
5. In ELISE, say "compro en CABA" (or your province), then "comparame mi lista de compras".

## 9. Known limitations

- **Search by name** covers only products with a barcode that chains publish. Fresh produce,
  meat and bread by weight use internal codes and can't be compared across chains.
- **Precision:** prices are a banner's provincial median, not a branch's quote. There are no
  store maps.
- **Promotions:** promo 1 is shown when most branches have it; promo 2 is only described with
  its conditions. Neither enters a total. SEPA doesn't give expiry dates in a structured form.
- **Coverage depends on the day:** this Thursday had 21 fresh banners. ChangoMas and Unicoop were
  stale; Libertad and others weren't in the file.
- **History** starts on the first day a product is linked or watched.
- **Alerts** are checked once per ingested weekday. Their list lives in chat; there is no
  Programados screen for them yet.
- **AMBA as one region:** not offered. ELISE asks "Ciudad o provincia".

## 10. Next steps

- **Blocked by the WAF unknown:** confirm the Trigger.dev download, or add an Argentine proxy.
- **Safe to add:**
  - a "Precios" entry inside Programados listing alerts;
  - interactive picks on the choices Surface (today the person answers by number or in Listas);
  - a barcode scanner on mobile;
  - per-branch prices near a shared location (needs a storage design for about 12 M rows/day,
    to be approved first).

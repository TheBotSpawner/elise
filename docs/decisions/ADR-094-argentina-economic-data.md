# ADR-094: Argentina's economic data (dollar, inflation, holidays)

**Status:** Accepted (2026-10-19). Follows the Weather (ADR-038) and Markets (ADR-074) pattern.

## Context

People in Argentina ask ELISE about the dollar by market, inflation and holidays. Before this
decision these questions had no structured source:

- prices went to web search;
- the model did its own arithmetic;
- holidays were invisible to planning.

Two public, keyless sources cover these questions. Both were checked against their docs and
live responses on 2026-10-19:

- **DolarApi** (`https://dolarapi.com/v1/dolares`): current quotes for oficial, blue, bolsa
  (MEP), contadoconliqui, mayorista, cripto and tarjeta, each with buy, sell and
  `fechaActualizacion`. ArgentinaDatos' own docs point here for current quotes.
- **ArgentinaDatos** (`https://api.argentinadatos.com/v1`):
  - daily dollar history per market (`/cotizaciones/dolares/{casa}` and `/{casa}/{YYYY/MM/DD}`; the
    full multi-market file is about 3 MB and is never read);
  - monthly and year-on-year CPI (`/finanzas/indices/inflacion`, `/inflacionInteranual`);
  - national holidays (`/feriados/{año}`, with `tipo` inamovible, trasladable or puente) and bank
    holidays (`/feriados-bancarios/{año}`);
  - fixed-term deposit rates (`/finanzas/tasas/plazoFijo`);
  - country risk (`/finanzas/indices/riesgo-pais/ultimo`) and UVA (`/finanzas/indices/uva`).

  On 2026-10-19 national holidays exist through 2027, while bank holidays for 2027 return 404.

Terms of use (https://argentinadatos.com/docs/uso):

- using the data and keeping a local copy is allowed;
- any publication must cite the service, and should also cite the original source;
- the suggested rate is about one read per series every 3 hours.

## Decision

1. **An internal capability, `economy`.** It is server-provided, read-only and needs no user
   connection, module or API key, like Weather and Markets.
   - The model sees domain tools, never provider tools: `economy.exchangeRates`,
     `economy.exchangeHistory`, `economy.inflation`, `economy.depositRates`,
     `economy.indicators` and `calendar.holidays`.
   - Providers live in `src/infrastructure/economy/argentina.ts` behind `EconomyCapability`
     (`src/core/economy/model.ts`).
2. **Which source for what.**
   - Current quotes come from DolarApi.
   - Every past day, period, index and calendar comes from ArgentinaDatos.
   - A past figure is never labelled current. A current quote older than 2 days, or a stale
     copy, is said with its date.
3. **Code computes, the model never does.** All of these live in `src/core/economy/model.ts`:
   - inflation compounds whole months, `(1+r₁)…(1+rₙ) − 1`, and reports missing months;
   - real return is `(1+n)/(1+i) − 1`;
   - deposits are simple interest on a 365-day year, plus the implied TEA;
   - conversions use the side of the trade (selling dollars gets `compra`, buying costs
     `venta`);
   - spread is `venta − compra`;
   - relative dates ("hace 3 meses") are computed in the user's calendar.
4. **Cache and limits.**
   - One cache shared by all workspaces (`src/application/economy-service.ts`), since the data
     is public. Concurrent reads are de-duplicated.
   - Freshness per dataset:

     | Dataset | TTL |
     |---|---|
     | Current quotes | 5 min |
     | Series (history, inflation, rates, indicators) | 3 h |
     | A past day's quote | 7 days |
     | Calendars | 24 h |

   - On a provider failure, the last good copy is served marked stale, with its read time.
   - Hosts are fixed HTTPS. Path parts are enums, validated dates or bounded years. Responses
     have an 8 s timeout and a 2 MB ceiling, and are validated with Zod row by row.
5. **Holidays are context, never events.**
   - The source's kinds are kept: national, movable, non-working `puente`, bank.
   - `planning.today` adds the week's holidays to its output. No tool writes them to any
     calendar.
6. **Country.** There is no explicit country on the profile.
   - Argentina's holidays are treated as the user's own only when the timezone is
     `America/Argentina/*` and the locale is Spanish.
   - An explicit "AR" works for anyone. Any other country is said to be unavailable, never
     substituted.
7. **Surface `economy`.** One typed Surface (rates, history, inflation, deposits, indicators,
   holidays). Every row is dated, and every card cites the source with its read time.

## Consequences

- Questions about the dollar, inflation and holidays no longer go to web search or to the
  model's own arithmetic.
- The per-instance cache multiplies reads by the number of instances. A shared store (Postgres
  or Redis) is the upgrade if traffic grows.
- **Not done yet:**
  - real return against the user's own Finance records (today the user states the nominal
    return);
  - FCI and collection fees;
  - "avisame cuando el MEP supere X" through Programados;
  - provincial holidays.
- **Desktop.** It renders the new Surface only from the release that includes it.

# ADR-074: Market data (FMP) and freshness-aware web research

**Status:** Accepted (2026-10-16). Extends ADR-015 (web) and ADR-038 (server-provided
capabilities). Migration `20261029000047_market_data.sql` registers the `markets` capability
(writes such as `markets.watch` are recorded against it).

## Context

- **Prices came from web search.** Stock questions ("¿Cómo está Alphabet hoy?") were answered
  from search snippets, which are imprecise and undated.
- **The web search ignored "recently".**
  - "¿Hay algún discurso de Milei recientemente?" returned a relevant 2024 speech. The current
    one only appeared after "buscalo de nuevo".
  - Freshness depended on an optional `recency` field the model could skip.
  - The weak-result check only looked at word overlap.
  - The reformulation could even drop the recency constraint.

## Decision: market data

- **Capability `markets`:** internal, server-provided, read-only. The tools are
  `markets.search`, `getQuote`, `getHistory`, `getProfile`, `watchlist`, `watch` and `unwatch`,
  named by capability and never by provider.
- **Core** (`core/markets/model`) owns:
  - the canonical types (instrument, quote with `asOf` and freshness, daily points, profile);
  - the provider contract;
  - the limits;
  - the deterministic math: day change, period change, high and low, and period ranges in the
    user's calendar.
  - The model never computes a change.
- **Provider: Financial Modeling Prep, stable API** (`infrastructure/markets/fmp`).
  - Verified endpoints: `search-name`, `search-symbol`, `quote`, `historical-price-eod/light`,
    `profile`.
  - **Auth:** the key goes in the `apikey` header, never in a URL. It lives in server-only
    `FMP_API_KEY` (local, Vercel, and Trigger.dev for scheduled briefs). It is not a user
    connection, so there is no "Connect FMP" button.
  - **Status mapping:** 401 → not configured; 402/403 or an "Error Message" body → not in plan;
    429 → rate limited; 5xx or a timeout → unavailable. No provider text reaches the user.
  - **Freshness:** FMP doesn't say whether a quote is real time, so quotes are "delayed" with
    their timestamp, never "live". The UI shows "Puede tener demora".
  - **Current plan:** batch quotes return 402, so it's one call per symbol, capped at 8 per
    question.
- **Service** (`application/markets-service`):
  - **Shared cache:** the data is public, so the cache is not per tenant. Quotes live 45 s,
    history 10 min, searches 6 h and profiles 24 h.
  - **De-duplication:** identical simultaneous requests make one provider call.
  - **Bounds:** history is limited to at most a year.
  - **Telemetry:** `market_data_request` with provider, operation, symbol, cache hit or miss,
    status and latency. Never the key.
- **Symbols come from the provider:**
  - `pickInstrument` prefers an exact ticker, then the primary US listing of the name, and
    mentions other share classes (Alphabet: GOOG and GOOGL).
  - An unknown name is reported, never invented.
- **Degrading:** a market tool that can't answer returns `available: false` with a reason
  (rate limited, not in plan, not configured). That is an output, not a failure, so the brief
  doesn't retry and worsen a quota. The model is told to check the web and quote it as
  "según <fuente>, <fecha>", never as a live quote.
- **Surface `market`:**
  - **Quote card:** price, change in signs and words, open/high/low/previous close, and "as of"
    in the user's timezone.
  - **History:** a sparkline with its computed change, low and high.
  - **Watch list:** the biggest movers first.
  - No buy, sell or holdings language anywhere.
- **Routing:**
  - **Prompt** (`MARKETS_GUIDANCE`): a price goes to markets; "por qué cayó" goes to the quote
    plus `web.searchNews` (day) in the same response, keeping the fact separate from likely
    causes; "última noticia" goes to the web only.
  - **Tool selection:** `MARKET_SIGNAL` (market words plus capital tickers) loads `markets.*`
    only for market questions. "¿Cuánto gasté?" stays Finance.
- **Followed assets:**
  - **Storage:** `user_preferences` `markets.watchlist`, holding resolved instruments.
  - **Not holdings:** they are interest, not ownership. Prompts and copy never say "tu cartera".
- **Programados and Morning Brief:** an opt-in "Mercados / Inversiones" block.
  - **Assets:** the schedule's own (searched in the form, stored as symbol and name), else the
    person's followed assets. None → "Elegí activos para seguir".
  - **Period and news:** today, 5 days, week or month; optional news for the two biggest movers.
  - **Fetching:** only when the brief runs, quotes first. History and news only when
    configured.
  - **Shown:** the 5 biggest movers out of N.
- **No trading, holdings or advice.** Before a public launch, check that the FMP license covers
  the intended commercial display. Only short-lived cache is stored, never raw datasets.

## Decision: fresh web research

- **Temporal intent** (`core/web/temporal`) comes from the user's words (es and en), resolved in
  the user's timezone. The windows are:

  | Words | Window |
  | --- | --- |
  | hoy | 1 day |
  | ayer | yesterday |
  | esta semana | 7 days |
  | este mes | the calendar month |
  | recientemente, último, actual | 30 days |

  - It sets the search recency when the model leaves it out (also for `web.searchNews`).
  - Timeless questions are untouched and cost nothing extra.
- **Validation:** each candidate is `within_window`, `older_than_asked` or `undated`, with
  rejection reasons (`TOO_OLD`, `NO_DIRECT_SUPPORT`).
  - **Confidence:** high with an in-window result that mentions what was asked, medium with only
    undated ones, low otherwise.
  - **Ranking:** in-window results are sorted first. The search engine's order never decides
    "latest".
- **Automatic recovery:** with low confidence, up to two more rounds that are actually
  different: current news plus a dated variant ("… octubre 2026", "… último"), in parallel,
  with results merged.
  - A time-sensitive search never silently drops its window.
  - If nothing fits, the output says `nothingWithinWindow` and gives the newest found with its
    date and how far back it is (30/90/365 days). It is never relabeled as recent.
- **Instructions to the model:**
  - answer only from in-window sources;
  - publication date ≠ event date;
  - coverage ≠ the artifact ("encontré cobertura", not "encontré el discurso").
- **Telemetry:** `web_research` with mode, rounds, queries, candidates, rejections, confidence
  and latency.

## Consequences

- Validated with the real FMP API, on the development plan:
  - quotes, symbol search and daily history work with header auth;
  - batch endpoints are refused with 402, which is handled as "not in plan".
- **Not built:**
  - a Connections status row for Markets (it stays invisible infrastructure, like Weather);
  - event-date extraction from page text (the model is instructed instead);
  - a shared cross-instance cache.

## Addendum (2026-10-17)

- **Plan coverage:** a provider plan may cover one listing and not another (FMP's free plan quotes
  GOOGL but not GOOG). When a symbol is outside the plan, `markets.getQuote` tries the same
  company's other primary listings in the same currency and says which one it quoted. Nothing is
  hardcoded per company.
- **Routing:** "Seguí X en mis resúmenes" / "lo que sigo" load the market tools even though they
  name no market word.
- **A missing migration degrades:** recording an action for a capability the database doesn't
  know yet fails that action with "needs the latest database update", never the whole turn.

# ADR-028: Presentation intelligence — temporal views, device location, Web discovery, speech in sync

**Status:** Accepted (2026-10-02). Extends ADR-027 (visualization planner), ADR-023 (location),
ADR-015 (Web), ADR-014/026 (voice). No migration: nothing new is stored.

## Context

Real sessions showed five related failures:

1. Schedules (course dates, deadlines) were answered only in prose, even with the visual system
   in place.
2. A route went to the wrong place on the first try: an address without a city resolved to the
   same street in another city.
3. Location could only be shared one tap at a time, so every "¿cuánto tardo hasta X?" asked
   for an origin.
4. "Buscame publicaciones…" returned one category page as if it were the answer.
5. With voice, results were already on the Canvas when ELISE said "voy a buscar…".

Constraints carried over: no extra model round trip for presentation; the model never writes
markup or code; nothing is invented to complete a view; no regression in latency.

## Root causes

- **Schedules.** ADR-027 only covered numbers. Dates had no tool, and nothing in retrieval told
  the model that its evidence was a schedule.
- **Address.** `location.getRoute` sent the user's raw text to the Routes API, which geocodes it
  with no context. The other end of the trip, the user's position and the map on screen were
  all ignored. The helper for "near X" took the geocoder's first answer as it was.
- **Web discovery.**
  - The Web pipeline kept only readable text: `<script>` blocks, including the schema.org JSON-LD
    that sites publish their listings in, were removed.
  - Passages were selected for a question, and a quick search reads two pages.
  - An anti-bot interstitial that answers `200` (or redirects to `/account-verification`) was
    accepted as the page.
- **Voice.**
  - In the legacy pipeline the model wrote `<spoken>Lo busco.</spoken>` and then called the tool.
    `SentenceChunker` ends a sentence only when whitespace follows it, and nothing follows the
    last sentence before a tool call, so that line stayed buffered for the whole tool run. It
    was only released with the next model call's text, after the Canvas already showed the
    results.
  - The acknowledgement also depended on the model's first token, about 1–2 s after the user
    spoke.

## Decision

### 1. Representation planning: deterministic stages, one family of typed specs

```text
evidence (tool results) → analyzer (shape hint, no model) → model states intent + evidence
  → planner (numbers: viz-planner, ADR-027 · dates: temporal-planner) → validated spec → Surface
```

- **Analyzer** (`core/workspace/representation.ts`).
  - When `knowledge.search` or `web.search` passages contain three or more distinct dates, the
    tool output carries a one-line instruction: call `ui.timeline` in the same response.
  - It only notices the shape and never extracts dates. Fractions such as "3/4" are not dates.
- **Temporal planner** (`core/workspace/temporal-planner.ts`, pure):
  - dates are validated in code (`2026-02-30` is rejected; a range ending before it starts is
    rejected);
  - every event needs a source;
  - duplicates are merged;
  - the same event dated differently by two sources is kept twice, both flagged `conflict`;
  - the view is chosen from the density of what is shown (see the table below);
  - fewer than three dates are refused as prose, unless the user asked for a schedule.

  | What is shown | View |
  |---|---|
  | One day (up to 7) of timed events | agenda |
  | Two or more meaningful durations (40% or more of events) | intervals (Gantt-like) |
  | At least 5 dates, at most 3 months, about 2.5 or more per month | calendar |
  | Otherwise | timeline |
- **Spec variant** `temporal` in `visualizationSpec`:
  - a view;
  - up to 40 events, each with title, start, inclusive end, kind (start, end, exam, deadline,
    holiday, break, meeting, delivery, milestone, general), importance, recurrence (never
    expanded into dates), source, conflict and uncertain;
  - a focus (kinds, from/to);
  - today.

  Sources gain an `excerpt`, so an event opens on the passage it came from.
- **Tool `ui.timeline`.**
  - Sources can be `[n]` (resolved against the Knowledge Surface on screen to the document,
    page and passage), a Surface handle, or a URL on screen.
  - Called without events, it re-arranges the schedule already on screen ("solo los parciales",
    "septiembre", "como calendario"), so the same Surface updates and no duplicate appears.
  - It has priority 86 and size large, so it leads the Canvas, with its documents beside it.
- **Renderer** (`features/workspace/viz/temporal-chart.tsx`):
  - timeline grouped by month with a "today" marker;
  - a month grid with that month's events listed below;
  - agenda;
  - intervals with month ticks.

  Kind is shown by node shape (not colour) and importance by weight. Ranges use the platform's
  `Intl.DateTimeFormat#formatRange`. Every event opens its details, source link and excerpt.
  Writing to the calendar stays `calendar.createEvent`, with approval.

### 2. Device location (`core/location/model.ts` → `DeviceLocation`)

- **Settings › Location: "Use my current location".**
  - It is a per-device preference, stored as one localStorage flag. The browser keeps the
    permission.
  - States: Allowed, Blocked, Unavailable, Needs permission, plus the device's reported accuracy.
- **Capture.**
  - Uses `getCurrentPosition` only; there is never a `watchPosition`.
  - One sample is kept in memory, rounded to about 110 m.
  - It is refreshed before a location question (the shared `LOCATION_SIGNAL`) if older than
    2 minutes, and reused for follow-ups for up to 15 minutes.
  - It is not used beyond 5 km reported accuracy.
  - It is sent only with the user's own messages, now also with GPT-Live delegations, which
    previously never carried it.
  - Nothing new is stored server-side.
- **Use.**
  - `location.getRoute`'s `from` is optional. With no origin, the route starts at the user's
    position. With no position, it asks to share one; it never guesses.
  - An origin the user names always wins.
  - The map labels the origin "Tu ubicación" and never shows coordinates.
- The type is runtime-neutral, so the Desktop Companion and native apps implement the same
  capture contract.

### 3. Geographic candidate resolution (`core/location/resolve.ts`, pure)

- **Candidates.**
  - The geocoder is biased to the context (Google `bounds`, about ±30 km, a preference and not
    a filter).
  - When the geocoder alone isn't a clear nearby match, a place search around the context is
    added.
- **Ranking.**
  1. The user's words (street, number, neighbourhood, city, country). One missing word
     outweighs any proximity, so an explicit city always wins.
  2. Closeness to the context: the user's position, the other end of the trip, what the map
     shows.
  3. The provider's order, as a tiebreak.
- **Confidence.**
  - *high*: use it.
  - *medium*: use it, and the answer names the pick, so a wrong one is caught. This covers a
    contextual winner, or no lexical match where the provider's semantic match is trusted (an
    acronym like "MALBA").
  - *low*: show the candidates and ask.
- **Route assembly.**
  - Once one end is settled, the other end is looked up again around it if its pick is more
    than 50 km away.
  - Pairs are ranked with a small distance penalty that never outweighs the words.
  - A route much longer than its ends allow (more than 4× the straight line plus 20 km), or a
    trip over 16 hours, is retried once with the next plausible pair.
  - With no candidates at all, the provider resolves the raw text, as before.

### 4. Web discovery (`web.discover`, `core/web/items.ts`, `core/web/discover.ts`)

- **Items come from structured data**, never from layout guesses:
  - schema.org JSON-LD (`Product`, `Vehicle`/`Car`, `Offer`, `ItemList`, `Accommodation`,
    `Course`, `Event`…), read in the fetcher;
  - title, canonical https URL, price and ISO currency, image, and up to six stated attributes
    (year, mileage, condition, location, rooms, fuel…).

  No marketplace is special-cased.
- **Limitations are typed.**
  - `blocked`: a 401/403/429, an anti-bot marker, or a redirect to a verification page.
  - `dynamic`: a script shell with no text.
  - `no_items`: the pages read had no concrete items.
  - `not_found`: the search found nothing on the named site.

  The fetcher refuses a verification page instead of returning it as content.
- **Bounded iteration.**
  - Limits: at most 3 steps, 8 pages, 4 in parallel, 4 followed links per listing, 2 model-given
    variants, and 40 s.
  - Each step searches (domain-restricted when the user named a site) or follows item links
    from listing pages without structured items.
  - Coverage is checked after every step: requested versus read, then `sufficient`, `partial`
    or `insufficient`.
- **Named site.** Only that site's items count, and nothing is substituted. Item pages known
  only from the search index are kept as `fromIndex`, with title and link, and labelled as such.
- **Ranking** is by constraint words, price bounds (same currency only), completeness, and
  whether the item was read rather than only indexed. Search order is a tiebreak. Without a
  named site, no site fills more than 6 of 12 slots.
- **Output.**
  - The `web_collection` Surface updates in place as pages are read: progressive, one Surface.
  - Price ranges per currency are computed in code.
  - Limitations are stated, and the site's own search page is offered as a link when nothing
    could be read.

### 5. Voice and Canvas on one lifecycle (`core/voice/speech-plan.ts`)

- **States.** USER_TURN → ACTIVITY_STARTED (`tool_started`) → RESULT_AVAILABLE
  (`tool_finished`, Surfaces) → FINAL (the verified spoken result). The Canvas renders on these
  same events and never waits for speech.
- **Speech categories.** `progress` is ephemeral. `result`, `approval`, `error` and
  `conversational` are never dropped.
- **Acknowledgement.** At ACTIVITY_STARTED a deterministic, localised acknowledgement ("Lo
  busco.", "Calculo la ruta.", "Reviso el material.", "Busco en nuestras conversaciones.",
  "Reviso tu agenda.") is queued while the tool starts, with no model call.
  - A line the model already wrote is flushed at that moment, as progress, and no second
    acknowledgement is added.
  - Instant tools (settings, the screen) get none.
- **Stale lines.** A progress line is played only while its work is still running, no result
  sentence has been queued, and it is younger than 6 s. This is checked when its turn in the
  queue comes, and again when its audio arrives. A stale line is dropped (`progress_dropped`
  trace).
- **Audio cache.** The acknowledgements are a few fixed lines. Their audio is synthesized once
  per server instance and voice, then served from memory (`synthesizeSentence`); replies are
  never cached. Without the cache, text-to-speech takes 1.5–2.5 s to its first byte, and real
  runs dropped every acknowledgement as stale. A client-side prefetch was tried and rejected:
  15 parallel requests took the browser's connections from transcription (+2 s).
- **Prompt.** `VOICE_GUIDANCE` no longer asks the model for a preamble: the model's spoken part
  is the result.
- **GPT-Live.** The voice model acknowledges itself. The backend's progress is already sent as
  silent context on `tool_started` (ADR-026), on the same lifecycle. No parallel system exists.
- **Telemetry.**
  - New marks: `ackReady`, `ackTts`, `toolsDone`, `resultSpeech`. They sit alongside
    `firstTool`, `firstSurface`, `audioStart` and `turnComplete`.
  - Development diagnostics print the ordered `[voice] timeline` per turn.
  - `/api/voice/metrics` no longer rejects every record: its `.strict()` schema refused the
    extra marks the client always sends.

## Measured (real Chrome, legacy voice, real STT/TTS/model, 2026-10-02)

| Turn | Before | After, cache cold | After, cache warm |
|---|---|---|---|
| Acknowledgement heard after the tool starts | Model preamble buffered until the tools finished, heard after the results | 1.1–4.9 s | **0.34–0.47 s** |
| Stale progress heard after results | yes (the reported bug) | none (0 heard) | none |
| Speech end → transcript | 0.6–0.9 s | 0.6–1.3 s | 0.6–0.8 s |
| Speech end → first tool | 3.7–6.0 s | 4.8–6.7 s | 3.6–4.8 s |

Model latency dominates the first-tool time and varies between runs. Presentation planning added
no model calls: every timeline, chart and collection in the validation came from the same
response as the answer.

## Web provider capabilities (as of 2026-10-02)

| Question | Answer |
|---|---|
| Search several times? | Yes. Each query is one provider call: up to 8 results with OpenAI hosted search (each search's own citations), or Tavily. Discovery uses 1–3 queries. |
| Follow links? | Yes. Discovery follows same-site item links from listing pages, up to 4 per page. |
| Fetch arbitrary pages? | Public http(s) only, SSRF-checked, 9 s, 1.5 MB, HTML/text, no cookies. |
| Paginate? | Not in the provider. Discovery covers more through query variants and listing pages, which often carry about 50 items in their JSON-LD. |
| Render dynamic sites? | No (no headless browser). Such pages are reported as `dynamic`. |
| Marketplaces | Category pages that publish JSON-LD give dozens of priced items. Many sites block search-result URLs (anti-bot) and are reported as `blocked`; their indexed item pages may still appear as `fromIndex`. |
| Practical yield | One readable listing page gives the full count (12). A blocked site gives only what the search index lists. |

## Consequences

- Schedules, comparisons and listings get a visual Surface in the same turn without being asked.
- No new model call is spent on presentation: planners and the analyzer are deterministic.
- Routes may make one or two extra cached geocoding or place calls when an address is
  ambiguous. A wrong pick is named in the answer.
- Discovery reads up to 8 pages: more Web usage per request, within the existing daily caps.
- The voice acknowledgement no longer waits for the model's first token. Stale announcements are
  dropped instead of being said late.
- **Not done:**
  - waterfall charts;
  - candlestick charts (they need real OHLC data);
  - persisting client voice timelines on `/admin/perf` (they are in development diagnostics
    and the `voice.turn_timing` log);
  - headless rendering for dynamic sites;
  - a geocoding quota per workspace.

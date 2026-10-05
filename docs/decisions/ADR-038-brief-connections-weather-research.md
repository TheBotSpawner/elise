# ADR-038: Brief connection semantics, Weather capability, Web research retries

**Status:** Accepted (2026-10-05). Extends ADR-006 (schedules), ADR-015 (Web), ADR-021 (Live
Canvas), ADR-023 (Location) and ADR-034 (voice acknowledgements). Migration
`20261011000030_weather.sql`.

## Context

- The scheduled Morning Brief said "Email no está conectado", "Calendario no está conectado",
  "Personal / UTN / Firbot Academy no está conectado" and "news no está conectado" four times,
  while every Google account was connected. The 2026-10-05 11:01 run stored
  `CAPABILITY_UNAVAILABLE` for every Google block plus `AI_NOT_CONFIGURED` for the summary.
  Cause: the Trigger.dev worker lacked server secrets (Google OAuth client and/or
  `ELISE_ENCRYPTION_KEY`, and `OPENAI_API_KEY`). `googleOAuthConfig()` threw
  `CAPABILITY_UNAVAILABLE` "Google connections are not configured on this server" for every
  account, and the brief rendered that code as "not connected". Connection resolution itself was
  already shared with chat (`loadWorkspaceBindings` + the executor) and resolved at run time.
- Weather was answered with generic web search ("clima" was a web keyword), with no structure
  and no visual.
- `web.search` gave up after one weak search.

## Decision

1. **A server-setup error is not a connection state.** New error code `SERVER_NOT_CONFIGURED`
   for missing server secrets (encryption key, Google/Notion OAuth client, Supabase secret, web
   search key). `CAPABILITY_UNAVAILABLE` keeps meaning "no account for this capability".
2. **Brief source states**, derived from error codes (`sourceState`): `auth_expired`,
   `permission_missing`, `no_connection`, `server_config`, `temporary`, `provider_error`,
   `needs_topics`. An empty result is not an issue; its section is omitted. `briefIssues` keeps
   one line per source and state: email follow-ups count as Email, repeated News topics collapse,
   and accounts that failed while others answered are listed on that one line. Stored briefs get
   the same treatment when rendered. Issues are shown last, compactly, under "Some sources need
   attention", with Connections linked only for states the user can fix.
3. **Worker secrets are checked by name.** At each schedule run ELISE logs
   `background.server_not_configured` with the missing names (never values). A brief whose
   failures are all `server_config` fails as `SERVER_NOT_CONFIGURED`, not "reconnect". The
   Trigger.dev environment needs `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SECRET_KEY`,
   `ELISE_ENCRYPTION_KEY`, `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` and
   `OPENAI_API_KEY`, with the same values as Vercel.
4. **Run invariants and telemetry.** A run has an explicit owner and workspace, and the resolved
   auth must match both. `brief.run` logs the blocks, calls, sections produced, empty sections and
   issues (counts only), for the interactive and the scheduled brief alike.
5. **Weather capability.** It is internal and read-only like Location. It has two tools:
   - `weather.current`: conditions now, plus today's range and rain.
   - `weather.forecast`: takes `when` (today, this_morning/afternoon, tonight, tomorrow and its
     parts, weekend, this_week, next_7_days, next_week) or a `date`. A single day or part of one
     returns hours; anything longer returns days.

   Dates are resolved by `resolvePeriod` in the place's own timezone, never by the model.
   "Esta semana" is the next seven days. The place comes from, in order: what the user named,
   their shared position (coarse, never in a payload), the brief's configured place, then the
   city of their IANA timezone (said as an assumption). ELISE asks only when none exists. The
   provider is Open-Meteo (`infrastructure/weather/open-meteo.ts`) behind
   `WeatherProvider`/`WeatherCapability`, with WMO codes mapped to ELISE conditions, an 8 s
   timeout, a 10-minute per-workspace cache and `weather.call` telemetry (location source,
   latency, cache). Its free API is non-commercial only. With `OPEN_METEO_API_KEY` the forecast
   uses `customer-api.open-meteo.com`. Data is CC BY 4.0 and credited on the Surface.
6. **Weather Surface.** One component (`canvas/weather.tsx`) serves the canvas, chat cards and
   the Morning Brief (compact). It has current, hourly and daily modes. Icons are ELISE's lucide
   set, and the temperature chart reuses the existing `LineChart`. In the brief, the `weather`
   block is on by default for new briefs. It takes `weatherLocation` (optional) and follows the
   brief's horizon.
7. **Information routing.**
   - `weather` is a core tool group, so "¿cómo va a estar esta semana?" has its tools even
     without a keyword. Weather words no longer select the web group.
   - The prompt routes: weather → Weather, places → Location, own data → their tools,
     documents → Knowledge, past conversations → Recall, the public world → Web.
   - Voice gets `check_weather` acknowledgements, both predicted from the words and from the
     tool.
8. **Web search retries.** When the results are weak (none, or no top result mentions the
   question's terms), `web.search` retries at most twice: first with the plain key terms, then
   without the recency filter. Results are merged and re-ranked. A domain the user named is kept
   on every attempt. If the best pages can't be read, the next ones are read. The tool reports
   the attempts, and with nothing found it says so; it never invents results.

## Consequences

- A brief can no longer blame the user's connections for an ELISE deployment problem. The fix
  for the observed runs is configuration: set the secrets listed in point 3 in Trigger.dev
  production and redeploy.
- Existing schedules keep their stored blocks. Weather appears in them once the user adds the
  block (new Morning Brief and Weekly planning presets include it).
- Commercial use of Open-Meteo requires a key. Geocoding stays on the public host until a
  documented commercial host exists.

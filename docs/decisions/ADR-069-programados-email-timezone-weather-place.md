# ADR-069: Programados cleanup — one "Correos", friendly time zones, weather city from Places

**Status:** Accepted (2026-10-16). Refines ADR-067 (Communication per account), ADR-038
(weather in briefs) and ADR-023 (Google Maps). No database migration.

## Decision: one "Correos"

- The two checkboxes "Mails importantes" and "Para responder y en espera" became one:
  **Correos**. Its info tip explains what it covers.
- `"needs_reply"` stays in `BRIEF_BLOCKS` only to read old rows. `normalizeBlocks` maps it to
  `"email"` when a schedule is read (`morningBriefConfigSchema.blocks`).
  - Either old option, or both, means "Correos" on.
  - Neither means off.
  - Saving writes only `"email"`; nothing else in the configuration changes.
- The form opens schedules already normalized, so an old one isn't "unsaved".
- The presets drop `needs_reply`.
- With Correos on, the brief makes one `email.triage` read with `waiting: true`. That read
  covers important and operational mail, replies owed and threads awaiting an answer.
  Spam, promotions and newsletters stay out.
- One Communication Surface per account, priority and caps are unchanged (ADR-067).

## Decision: labels

- "Finanzas" / "Finance". What it covers (month to date, yesterday's spending) is in an info tip.
- "Qué mira ELISE" in reading order: Agenda, Correos, Tareas, Hábitos, Objetivos, Finanzas,
  Noticias, Clima, Conocimiento, Slack. One column on phones.

## Decision: time zones

- **Canonical id.** `core/time.canonicalTimezone` maps legacy aliases (Chrome's Intl lists
  `America/Buenos_Aires`, `America/Cordoba`…) to canonical ids
  (`America/Argentina/Buenos_Aires`). Schedules (`timezoneSchema`) and profile preferences
  save the canonical id; old values keep working.
- **One picker.** `components/shared/timezone-picker.tsx` is used by Programados, Settings ›
  General and onboarding. It is built on the existing `Combobox` and `lib/timezones`.
  - **Label:** "Buenos Aires, Argentina", with "UTC-3 · America/Argentina/Buenos_Aires"
    underneath.
  - **Countries** come from a small zone → country table, localized with `Intl.DisplayNames`.
  - **Search** matches city, country (es and en), "UTC-3" and the IANA id.
- **Argentina first.** Buenos Aires is listed first when the person's zone is Argentine or the
  UI is Spanish (ELISE's Spanish is Rioplatense). It is never chosen for anyone.

## Decision: weather city (Google Places)

- **Picker.** The free-text field became `WeatherPlacePicker`: suggestions while typing, and
  only a chosen suggestion is saved.
- **Server proxy.** Server actions call `application/location-service`
  (`suggestWeatherCities`, `weatherCity`) with the existing **server key**
  (`GOOGLE_MAPS_SERVER_API_KEY`). The browser key and any SDK are not used, so no key reaches
  the client.
- **Places API (New) calls** (`infrastructure/location/google-maps.ts`):
  - `POST places:autocomplete` with `includedPrimaryTypes` locality, administrative areas 1–2,
    sublocality and postal_town — never businesses, POIs or addresses.
  - A `regionCode` bias toward the person's country.
  - `GET places/{id}` (field mask: id, displayName, formattedAddress, location,
    addressComponents).
  - One session token covers typing plus the details call.
- **Stored** as `configuration.weatherPlace = {placeId, displayName, city, region, country,
  countryCode, lat, lng}`. `weatherLocation` (the city name) is kept alongside for display and
  older readers.
- **Run time.** The brief passes `place {name, lat, lng}` to `weather.forecast`, so no
  geocoding by name. Model calls never set `place`.
- **Legacy.** A schedule with only `weatherLocation` keeps being geocoded by name. The picker
  shows that text and suggests pinning a city.
- **No Places.** Without a server key or the API enabled, the picker says "Google Places no
  está disponible en este entorno" and falls back to free text, as before.
- **Setup:** enable **Places API (New)** for the server key, in addition to the APIs ADR-023
  already lists. No new key.
- **Decoupled.** Time zone and weather city are independent (time zone Buenos Aires, weather
  Bariloche). An empty weather city still means the time zone's city.

## Also

- Home's "Morning Brief listo · Ver" sat a few pixels below the other items in its row. The
  other items' links were full height with baseline alignment from `md`; now every item is
  centred in the 32 px cell.

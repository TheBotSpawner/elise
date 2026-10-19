# ADR-086: Weather place resolution

**Status:** Accepted (2026-10-18). Refines ADR-038 (weather) and ADR-028 (device position).

## Context

"¿Va a llover hoy en Capital?" from Buenos Aires showed the weather for Capitol, Metro Manila.
The weather tool sent the name to Open-Meteo's geocoder and used its first result. That search is
fuzzy and name-only: "Capital" → "Capitol" (PH), "CABA" → "Caba" (PH), "Capital Federal" → nothing.
Nothing checked the answer.

## Decision

`src/core/weather/place.ts` (pure, tested) decides; the provider only returns candidates (now with
country code, region, GeoNames feature code and population, up to 10, optionally restricted by
`countryCode`).

1. **Query:** `"Capitol, Metro Manila, Philippines"` → name + qualifiers. A country qualifier (in
   Spanish or English, via `Intl.DisplayNames`) restricts the search.
2. **Regional names, only in region:** "Capital", "CABA", "Cap Fed" mean Buenos Aires City when the
   region is Argentina; "Capital Federal", "Ciudad (Autónoma) de Buenos Aires", "Buenos Aires
   Capital" also with no region known. Never with another region.
3. **Validation:** a candidate's name must match what was asked (exact, all words, or extra words
   naming its region/country); every qualifier must match. Look-alikes are rejected.
4. **Ranking:** significance (capital +3, region seat +2/+1, log population) + region hint (+3) +
   closeness to a shared position (+3 ≤100 km, +1.5 ≤500 km) + regional-name region (+2).
5. **Confidence:** two far-apart candidates within 1.5 points → ask, naming them. A lone, small place
   outside the user's region → ask. Qualified requests resolve at high confidence.

**Precedence:** the place named in the latest request (corrections replace it) → "here" with a
shared, fresh position (ADR-028; refreshed now also for weather-here questions) → the city of the
timezone, said as an assumption (ADR-038). An explicit "here" without a position asks.

**Hints are weak:** the weather place on screen (its `countryCode`) or the timezone's country rank
candidates; they are never presented as where the user is.

**One label:** the card, the model's `place` and the forecast request come from the same resolved
candidate; the guidance tells the model to name exactly that.

**Telemetry:** `weather.location_resolved` / `weather.location_missing` with outcome, source,
alias, country codes, confidence and counts — never place names or coordinates. Geocode cache keys
include the restricting country.

## Consequences

Some genuinely ambiguous names now ask instead of answering (Paris from the US, Córdoba from Spain).
Adding a regional name is one table entry with its country. Desktop shares the web flow; Electron's
geolocation often has no provider, which degrades to "no position" (asks or uses the timezone city).

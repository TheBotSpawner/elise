# ADR-133: Recommending places from Maps, with what decides

**Status:** Accepted (2026-11-03). Extends ADR-023 (Location).

## Context

"Un ramen por el Barrio Chino a las nueve y media" got two names and "no pude confirmar". The run
shows why: 92 tools exposed, none of them `location.*`, and `web.search` as the only source.

- **The signal missed it.** `LOCATION_SIGNAL` knew "cerca", "restaurant", "café", not "comer" or
  "ramen". Only `location.getRoute` was always available.
- **The guidance sent reviews to the web.**
- **Search brought little.** Rating, ratings count and "open now". Hours and price needed one
  `getPlace` per place, and reviews weren't requested anywhere.

One real Text Search (2026-11-03, Barrio Chino, Spanish) returned hours, next closing time, price
and 5 reviews for all three places, and a Gemini review summary for two of them.

## Decision

1. **Where to go reaches Maps.** `location.searchPlaces` is always available (ADR-123), and the
   signal knows eating and going out, which also refreshes the device's position.
2. **One search brings it all.** Price, hours, next closing time, review summary and reviews come in
   the same call.
3. **The model sees that for the first 3 places:** two reviews, cut to 240 characters each.
4. **The guidance** starts these questions in Maps, checks a named time against hours, and adds
   travel times with `compareTravelTimes` when the position is known.

## Consequences

- **Cost:** asking for reviews moves each search and detail call to a higher Places SKU. The price
  difference wasn't checked.
- **Google's terms aren't reviewed.** Review text reaches the model and isn't kept in the map card,
  and the reply paraphrases it as what people say on Google. Whether that fits the Maps Platform
  terms, and the attribution they ask for, is pending. The Gemini summary's disclosure isn't shown.
- About 1,000 more input tokens on a place search.
- Not tested end to end with the real model.

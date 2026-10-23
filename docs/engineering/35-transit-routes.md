# Public transport routes with lines — report (ADR-113)

Date: 2026-10-23.

## Bug

`src/infrastructure/location/google-maps.ts` `route()` called `computeRoutes` with
`X-Goog-FieldMask:
routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline,routes.warnings,routes.legs.startLocation,routes.legs.endLocation`.
Google returned no steps, so no `transitDetails` ever reached ELISE. `Route` couldn't hold them,
and the tool's instructions asked for "the time and arrival in one sentence". Voice therefore said
"tardás 30 minutos".

There was also no way to:
- arrive by a time (`arrivalTime`);
- prefer a vehicle (`transitPreferences.allowedTravelModes`);
- prefer less walking or fewer transfers;
- ask for alternatives.

## Fix

**Core:** `src/core/location/model.ts`
- `TransitItinerary` / `TransitRide` / `TransitWalk`;
- `vehicleOf` (Google vehicle types to bus, subway, train, tram, ferry or other);
- `meetsModes` ("solo colectivo");
- `distinctItineraries` (drops the same trip at later times);
- `vehicleWord` ("Colectivo"/"Subte" in Spanish);
- `describeItinerary` (the steps the model reads);
- the route request's `arriveBy`, `transitModes` and `transitPreference`.

**Adapter:** `src/infrastructure/location/google-maps.ts`
- The transit request (TRANSIT, alternatives, preferences, `arrivalTime` xor `departureTime`,
  `es-419`).
- The transit field mask, with exactly `routes.legs.steps.travelMode, distanceMeters,
  staticDuration, transitDetails`.
- `transitItinerary` (the parser). Driving, walking and cycling requests are unchanged.

**Tool:** `src/core/tools/location.ts` (`location.getRoute`)
- New inputs: `arriveBy`, `transitModes`, `onlyTransitModes`, `transitPreference`.
- Output: `itineraries[].steps`, `transfers`, `walkMinutes`, `leaveAt`/`arriveAt`, plus
  `noneOnlyWith` and `stepsMissing`.
- Instructions require naming the lines in voice and text.
- The map payload includes the itineraries. Comparisons include the transit option's lines.

**Surface:**
- `src/core/workspace/location.ts`: schema for itineraries.
- `src/core/workspace/registry.ts`: `describeMap` includes the lines, for follow-ups.
- `src/features/workspace/canvas/map.tsx`: `Itineraries` card (line badge with the provider's
  colour, direction, board and get-off stops with times, stops, walks, "Horarios estimados").
- i18n es/en.

**Intent:**
- `tool-selection.ts`: `LOCATION_SIGNAL` covers bondi, micro, tren, línea, combinación,
  transbordo, parada, estación, ramal and "me tomo"/"me bajo".
- `context.ts`: public transport guidance.

## Live checks (real Routes API, local server key, 2026-10-23 ~11:00 ART, 5 requests)

`scripts/transit-smoke.ts`:

| Query | Result (as returned by Google) |
|---|---|
| Conde 3095 → Ramón Falcón 3167, CABA, bus | **19** towards "Boulogne - Plaza Miserere" from Iberá y Conde → Monroe y Tronador (5 stops), then **133** towards "Pte. Saavedra - Barracas" to Rivadavia y Argerich (31 stops). 40 min, 1 transfer. Alternatives via 114 + 8, or 76B direct (68 min). |
| Plaza de Mayo → Cabildo y Juramento | **Subte D** towards Congreso de Tucumán, Catedral → Juramento (14 stops), 29 min. Bus alternatives 111 + 152, or 29B. |
| Plaza de Mayo → Plaza Italia, subte | **Subte D**, Catedral → Plaza Italia (9 stops), 20 min. Repeated every 5 min, now kept once. |
| Plaza de Mayo → UTN Medrano, arrive 14:15 | **64** at 13:45 → Pueyrredón y Tucumán, then **26** → Lavalle y Medrano (14:10), plus alternatives. Arrival planning works. |
| Plaza San Martín → Ciudad Universitaria, **Córdoba** | **43** towards "20 de Junio a Ciudad Universitaria", 14 min. No AMBA-specific code involved. |

Not run here: a full voice turn in the Web and Desktop UI against production (needs the deployed
app). The tool output and Surface are covered by tests.

## Tests

`tests/unit/location/transit.test.ts`, 13 tests:
- the parser: walk + bus + walk, bus + subway, train + bus, missing fields, no steps;
- the steps the model reads, and the Argentine vehicle words;
- duplicate trips removed;
- "solo colectivo";
- the request: body, `arrivalTime` xor `departureTime`, field mask without `*`, driving
  unchanged;
- the tool: lines reach the output and the map Surface, "only bus" with none qualifying,
  `arriveBy` in Buenos Aires time implying transit, no steps leading to no invention;
- the Rioplatense intent words.

The existing location tests (36) still pass.

## Cost

- Each transit question is one `computeRoutes` call, as before (same 2-minute cache, keyed by
  the request).
- Asking for steps and `transitDetails` doesn't add calls. Check in Cloud Billing whether these
  requests are billed as Routes Essentials or Pro (Pro is roughly 2× Essentials). Comparisons
  without a mode still make 3 calls (drive, transit, walk), as before.
- No new API, key or SKU was enabled.

## Limitations and next steps

- No live vehicle positions or arrivals; the times are Google's schedule.
- `headsign` is the direction shown on the vehicle, not a guaranteed branch ("ramal").
- No fares (not requested, to keep the mask minimal). Add `routes.travelAdvisory.transitFare`
  if wanted.
- Google Maps links for transit trips are the existing `mapsUrl`, unchanged.

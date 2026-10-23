# ADR-113: Public transport with its lines (Routes API transit details)

**Status:** Accepted (2026-10-23). Extends ADR-023 (Location) and ADR-102 (address resolution).

## Context

"¿Qué colectivo me tomo?" got "tardás 40 minutos" and no line.

**Root cause:** `GoogleMapsLocation.route` asked `computeRoutes` for an `X-Goog-FieldMask` of
distance, duration, polyline and leg ends only. Google never returned
`routes.legs.steps[*].transitDetails`, and `Route` had no field for them. There was also no
`arrivalTime`, no `transitPreferences` and no alternatives.

## Decision

1. **Transit request.** For `mode: transit`, the same Routes call
   (`directions/v2:computeRoutes`, same server key) sends:
   - `computeAlternativeRoutes: true`;
   - `transitPreferences.allowedTravelModes` (BUS / SUBWAY / TRAIN / LIGHT_RAIL) when the
     person names a vehicle;
   - `transitPreferences.routingPreference` (`LESS_WALKING` / `FEWER_TRANSFERS`) when they ask;
   - `arrivalTime` **or** `departureTime`, never both;
   - `languageCode: es-419`;
   - no intermediates and no driving `routingPreference`.

   Its field mask adds exactly `routes.legs.steps.travelMode`, `.distanceMeters`,
   `.staticDuration` and `.transitDetails`, never `*`. Other modes keep their old request and mask.
2. **`TransitItinerary` contract** (core) is filled by a parser that keeps everything the provider
   gave:
   - consecutive walking steps merged into one walk;
   - for each ride: vehicle, line (`nameShort` else `name`), long name, colours, agency,
     `headsign`, boarding and alighting stops, scheduled times and stop count;
   - for the trip: transfers, walking totals and leave/arrive times.

   Missing fields stay `null`, never filled in.
3. **The model gets the lines in readable steps** ("Colectivo 152, hacia "Olivos", subir en …,
   bajar en …, 14 paradas"), at most three distinct itineraries. Google repeats one trip at later
   departures, so repeats are dropped.
   - Its instructions require the answer, spoken too, to name the lines, direction, stops,
     transfers and walks, never only the time. Times are timetable estimates, never live.
   - "Solo colectivo": itineraries using another vehicle are never offered as meeting it, since
     Google treats allowed modes as a preference. If none qualifies, ELISE says so.
   - No steps from the provider: ELISE says the lines aren't available and never names one from
     memory.
4. **The map Surface carries the same itineraries.** A card under the route shows each line badge
   in the provider's colour, the direction, where to board and get off with times, stops and
   walks. Follow-ups read the same data from the Surface description.
5. **Intent.**
   - "bondi, micro, tren, línea, combinación, transbordo, parada, estación, ramal, me tomo, me
     bajo" bring the location tools.
   - `arriveBy` or a named vehicle imply transit.
   - When no mode is named, the comparison's transit option also says its lines.
   - In Spanish the vehicle is said the Argentine way ("colectivo", "subte"), not Google's
     "Autobús"/"Subterráneo".

## Consequences

- Answers to transit questions now name lines. The same data drives voice, chat, Web and Desktop.
- No new API, key or provider. Each transit question is still one Routes request (cached
  2 minutes).
- No live arrivals ("¿cuándo viene el 60?"): Google gives scheduled times here, and ELISE says so.

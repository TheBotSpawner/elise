# ADR-023: Location + Maps capability

**Status:** Accepted (2026-10-02). Extends ADR-007 (capabilities), ADR-013 (Live Workspace),
ADR-015 (Web) and ADR-021 (Live Canvas). Migration `20261006000025_location.sql`.

## Context

Users ask where things are and how long it takes to get there: "cafés near the Obelisk", "the
closest pharmacy", "how long from Plaza de Mayo to MALBA", "when should I leave for my next
meeting". Web search answers what pages say about a place, not where it is or the travel time.
These answers are visual (a map, a route), so they belong in the Live Canvas.

## Decision

1. **A provider-independent `location` capability** (`core/location/model.ts`). It is internal
   (no user connection) and read-only. Its six tools are named after the capability, never the
   vendor: `location.searchPlaces`, `getPlace`, `geocode`, `reverseGeocode`, `getRoute`,
   `compareTravelTimes`. The Core sees `LocationCapability`, and the Google adapter lives in
   `infrastructure/location/google-maps.ts`. The tools are offered only when the server key is
   set.
2. **Google Maps Platform, current APIs only**:
   - **Places API (New)**: `places:searchText`, with location bias and `rankPreference:
     DISTANCE` for "closest"; `places/{id}`; and photo `media` with `skipHttpRedirect`, which
     returns a photo URL that carries no key.
   - **Routes API**: `computeRoutes` (traffic-aware for driving) and `computeRouteMatrix`.
   - **Geocoding API**.
   - **Maps JavaScript API**, loaded async on the `weekly` channel, with `AdvancedMarkerElement`
     and `PinElement`.

   The legacy Places, Directions and Distance Matrix APIs and the deprecated `google.maps.Marker`
   are not used.
3. **Surfaces**: `map` (modes `places`, `route`, `compare`, `locate`) and `place`. Payloads are
   zod-validated data: coordinates, names, numbers and https links. They never carry markup or
   map code (`core/workspace/location.ts`). The UI owns the map (`canvas/map.tsx`):
   - Pins are numbered. Selecting a pin or a list row selects the other.
   - The map uses ELISE's dark or light colour scheme.
   - Mobile focus shows the list as a bottom sheet over the map.
   - Without a browser key, or if the map fails to load, the same data renders as a list.

   `describe()` numbers the places and includes their refs (`place:<id>`), so the model can
   resolve "the second one" or "that café" in text and voice.
4. **The user's position is explicit, coarse and ephemeral.**
   - It exists only after the user taps "Share my location" on a `locate` Surface. A tool shows
     that Surface when it needs "here" and doesn't have it; ELISE never guesses where the user
     is.
   - The browser rounds it to 3 decimals (~110 m) and keeps it in memory only, for 15 minutes or
     until reload. It is sent only with the user's own messages, and the server rounds it again.
   - It is never stored or logged. It is never returned to the model or written into a payload.
     `forStorage` drops the route line and start of a route that began at the user's position
     before the workspace is saved. A Maps link never contains it, because without an origin
     Google Maps starts from the device.
   - `Permissions-Policy: geolocation=(self)`.
5. **Context**: the next meeting's location comes from the calendar (`calendar.listEvents`) and
   is then used as the route destination. An event without a location is reported; ELISE never
   invents one.
6. **Keys**: two separate keys.
   - `GOOGLE_MAPS_SERVER_API_KEY` is server-only (`config/server-env.ts`) and restricted to
     Places API (New), Routes and Geocoding.
   - `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` is restricted to the Maps JavaScript API and to the app's
     HTTP referrers.
   - `NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID` is a vector Map ID. Development falls back to
     `DEMO_MAP_ID`.

   The CSP allows Google's map hosts only when the browser key is set. Server calls never borrow
   the browser key.
7. **Cost controls**:
   - Every Places and Routes request sends a field mask with only the fields shown. Search
     includes rating and open-now, which bills as Text Search Enterprise.
   - Photos are fetched only for the single-place view.
   - Results are cached per workspace for 10 minutes (places, geocodes) or 2 minutes (routes).
   - Limits: 8 places per search, 5 stops, a 3×10 matrix, an 8-second timeout.
   - Every call is recorded in `usage_events` (`operation = 'maps'`, provider
     `google_maps.<api>`, estimated with the list prices in `config/pricing.ts`) with no query,
     address or coordinates.
8. **Out of scope**: turn-by-turn navigation, tracking, geofencing, booking, trip planning and
   offline maps. Opening the place or route in Google Maps is the user's choice, through a link.

## Consequences

- Maps can be enabled per deployment with three env vars and four enabled APIs (README).
- Transit routes ignore stops (an API rule), and the tool says so.
- "here" is approximate by design. Very short walking distances near the user can be off by
  about 100 m.
- There is no per-workspace daily quota yet, only usage visibility. Add one, like the web
  limits, if usage warrants it.

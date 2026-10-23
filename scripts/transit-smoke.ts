/**
 * ADR-113 live smoke: real Routes API transit queries through ELISE's own adapter (the server key
 * from .env.local), printed as the model would read them. Each query is one billed request.
 *   npx --yes tsx@4.19.2 --conditions=react-server --env-file=.env.local --tsconfig tsconfig.json scripts/transit-smoke.ts
 */
import { describeItinerary, type TransitMode } from "../src/core/location/model";
import { GoogleMapsLocation } from "../src/infrastructure/location/google-maps";

const QUERIES: { from: string; to: string; modes?: TransitMode[]; arriveBy?: string }[] = [
  {
    from: "Conde 3095, Ciudad Autónoma de Buenos Aires",
    to: "Ramón Falcón 3167, Ciudad Autónoma de Buenos Aires",
    modes: ["bus"],
  },
  { from: "Plaza de Mayo, Buenos Aires", to: "Av. Cabildo y Juramento, Buenos Aires" },
  { from: "Plaza de Mayo, Buenos Aires", to: "Plaza Italia, Buenos Aires", modes: ["subway"] },
  {
    from: "Plaza de Mayo, Buenos Aires",
    to: "UTN Medrano, Av. Medrano 951, Buenos Aires",
    arriveBy: "14:15",
  },
  { from: "Plaza San Martín, Córdoba, Argentina", to: "Ciudad Universitaria, Córdoba, Argentina" },
];

async function main() {
  const tz = "America/Argentina/Buenos_Aires";
  const g = new GoogleMapsLocation(process.env.GOOGLE_MAPS_SERVER_API_KEY!);
  for (const q of QUERIES) {
    // "14:15" tomorrow in Buenos Aires.
    const arriveBy = q.arriveBy
      ? new Date(
          `${new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)}T${q.arriveBy}:00-03:00`,
        ).toISOString()
      : null;
    const started = Date.now();
    try {
      const r = await g.route({
        origin: { address: q.from },
        destination: { address: q.to },
        stops: [],
        mode: "transit",
        departAt: null,
        arriveBy,
        transitModes: q.modes ?? [],
        transitPreference: null,
        language: "es",
      });
      console.log(
        `\n${q.from} → ${q.to}${q.modes ? ` [${q.modes}]` : ""}${arriveBy ? ` (llegar ${q.arriveBy})` : ""} · ${Date.now() - started} ms`,
      );
      if (!r) {
        console.log("  (no route)");
        continue;
      }
      for (const [i, it] of (r.itineraries ?? []).entries())
        console.log(
          `  Opción ${i + 1}: ${Math.round(it.durationSeconds / 60)} min, ${it.transfers} comb., ${Math.round(it.walkMeters)} m a pie\n    - ${describeItinerary(it, tz, "es").join("\n    - ")}`,
        );
    } catch (e) {
      console.log(`\n${q.from} → ${q.to}: ERROR ${(e as Error).message}`);
    }
  }
}

void main();

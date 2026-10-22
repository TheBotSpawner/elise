/**
 * ADR-111: measures one SEPA day locally (no database, no network): products, chains,
 * aggregated prices, each province's compressed snapshot, time and memory. Usage:
 *   npx --yes tsx@4.19.2 --tsconfig tsconfig.json scripts/sepa-measure.ts <sepa_day.zip> [outDir]
 */
import { createReadStream, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { aggregateSepaDay } from "../src/infrastructure/shopping/sepa";
import { buildSnapshots, encodeSnapshot } from "../src/infrastructure/shopping/snapshot";

async function main() {
  const [file, outDir] = process.argv.slice(2);
  if (!file) throw new Error("Usage: scripts/sepa-measure.ts <sepa_day.zip> [outDir]");
  const started = Date.now();
  const day = await aggregateSepaDay(createReadStream(file), new Date());
  const parsedS = Math.round((Date.now() - started) / 1000);
  const snaps = buildSnapshots(
    day,
    new Date().toISOString().slice(0, 10),
    file.split(/[\/]/).pop()!,
  );
  const sizes: Record<string, number> = {};
  let total = 0;
  if (outDir) mkdirSync(outDir, { recursive: true });
  for (const [region, s] of snaps) {
    const gz = encodeSnapshot(s);
    sizes[region] = Math.round(gz.length / 1000);
    total += gz.length;
    if (outDir) writeFileSync(join(outDir, `${region}.json.gz`), gz);
  }
  if (outDir)
    writeFileSync(join(outDir, "catalog.json"), JSON.stringify([...day.products.values()]));
  console.log(
    JSON.stringify(
      {
        parseSeconds: parsedS,
        totalSeconds: Math.round((Date.now() - started) / 1000),
        peakRssMb: Math.round(process.memoryUsage().rss / 1e6),
        products: day.products.size,
        prices: day.prices.length,
        snapshotsKb: sizes,
        snapshotsTotalMb: Math.round(total / 1e5) / 10,
        stats: { ...day.stats, chains: day.stats.chains },
      },
      null,
      2,
    ),
  );
}

void main();

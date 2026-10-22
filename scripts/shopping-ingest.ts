/**
 * ADR-111: runs the SEPA ingestion by hand, against the database in the environment
 * (NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY, e.g. from .env.local). The first load,
 * or a day when the cloud download is blocked. Usage:
 *   npx --yes tsx@4.19.2 --conditions=react-server --env-file=.env.local --tsconfig tsconfig.json scripts/shopping-ingest.ts            (newest day)
 *   npx --yes tsx@4.19.2 --conditions=react-server --env-file=.env.local --tsconfig tsconfig.json scripts/shopping-ingest.ts <file.zip> <YYYY-MM-DD>
 */
import { createReadStream } from "node:fs";
import { basename } from "node:path";

import { ingestSepa } from "../src/application/shopping-ingest";

async function main() {
  const [file, date] = process.argv.slice(2);
  const result = file
    ? await ingestSepa({
        source: createReadStream(file),
        file: { date: date ?? new Date().toISOString().slice(0, 10), name: basename(file) },
      })
    : await ingestSepa({ force: process.argv.includes("--force") });
  console.log(JSON.stringify(result, null, 2));
  if (result.status === "failed") process.exitCode = 1;
}

void main();

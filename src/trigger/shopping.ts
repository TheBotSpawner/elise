import { schedules } from "@trigger.dev/sdk";

import { ingestSepa } from "@/application/shopping-ingest";

/**
 * ADR-111: the daily SEPA ingestion. SEPA publishes each weekday's file in the morning; this
 * checks at 11:00 and 17:00 (Buenos Aires) and does nothing once the day is in. Off unless
 * SHOPPING_INGEST_ENABLED=true in this environment: deploying never starts a ~330 MB download.
 * It runs on the project's default machine and duration: a day needs ~2.5 GB and a few minutes, so
 * before enabling it in the cloud raise `machine`/`maxDuration` here (a paid Trigger.dev plan;
 * overriding them made the whole project's deploy fail). Until then, scripts/shopping-ingest.ts.
 */
export const shoppingIngestTask = schedules.task({
  id: "shopping-sepa-ingest",
  cron: { pattern: "0 11,17 * * 1-6", timezone: "America/Argentina/Buenos_Aires" },
  retry: { maxAttempts: 2, minTimeoutInMs: 60_000, maxTimeoutInMs: 300_000 },
  run: async () => {
    if (process.env.SHOPPING_INGEST_ENABLED !== "true") return { status: "disabled" };
    return ingestSepa();
  },
});

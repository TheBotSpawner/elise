import { schedules } from "@trigger.dev/sdk";

import { consolidationSweep, memorySweep } from "@/application/memory-learning";

/**
 * Thin Trigger.dev entry points for native memory (ADR-107). Learning after each turn runs in
 * the recall-index task; these are the safety net and the daily consolidation. Both touch only
 * people who opted in, do nothing unless MEMORY_LEARNING=on, and stop at the monthly caps.
 */

/** Every 15 minutes: conversations that went quiet with turns not learned from yet. */
export const memorySweepTask = schedules.task({
  id: "memory-sweep",
  cron: "*/15 * * * *",
  maxDuration: 600,
  run: async () => memorySweep(50),
});

/** Daily: merge duplicates, retire outdated inferences, rebuild the short profile. */
export const memoryConsolidateTask = schedules.task({
  id: "memory-consolidate",
  cron: "30 6 * * *",
  maxDuration: 900,
  run: async () => consolidationSweep(200),
});

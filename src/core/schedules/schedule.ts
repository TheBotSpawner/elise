import { z } from "zod";

import { addDays, isLocalDateTime, isValidTimezone, todayIn, zonedDateTimeToUtc } from "../time";

/**
 * Schedules ("Programados", docs/architecture/13 §21-61). A Schedule is structured data —
 * when, what, which capabilities, how to deliver — never an opaque prompt. Timing is
 * computed here, in the Schedule's IANA timezone, so 07:30 stays 07:30 local across DST.
 */

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Expected HH:mm (24 h)");

export const scheduleDefinitionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("once"),
      at: z.string().refine(isLocalDateTime, "Expected local YYYY-MM-DDTHH:mm"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("weekly"),
      /** 0 = Sunday … 6 = Saturday. Every day = all seven. */
      days: z
        .array(z.number().int().min(0).max(6))
        .min(1)
        .max(7)
        .transform((d) => [...new Set(d)].sort()),
      time,
    })
    .strict(),
]);

export type ScheduleDefinition = z.infer<typeof scheduleDefinitionSchema>;

export const timezoneSchema = z.string().min(1).max(64).refine(isValidTimezone, "Unknown timezone");

const weekday = (isoDate: string) => new Date(`${isoDate}T00:00:00Z`).getUTCDay();

/**
 * The first occurrence strictly after `after`, or null when there is none (a past one-time
 * schedule). Each local date is converted on its own, so DST changes keep the wall-clock time.
 */
export function nextOccurrence(
  def: ScheduleDefinition,
  timezone: string,
  after: Date,
): Date | null {
  if (def.kind === "once") {
    const at = zonedDateTimeToUtc(def.at, timezone);
    return at > after ? at : null;
  }
  const today = todayIn(timezone, after);
  for (let i = 0; i <= 7; i++) {
    const date = addDays(today, i);
    if (!def.days.includes(weekday(date))) continue;
    const at = zonedDateTimeToUtc(`${date}T${def.time}`, timezone);
    if (at > after) return at;
  }
  return null;
}

export type ActionType = "morning_brief";

/**
 * Missed-run policy by action type (docs/architecture/13 §53): a Morning Brief generated in the
 * afternoon is useless, so it is skipped when too late; other types may run late.
 */
export const MAX_LATENESS_MINUTES: Record<ActionType, number> = {
  morning_brief: 180,
};

export function isMissed(actionType: ActionType, scheduledFor: Date, now: Date): boolean {
  return now.getTime() - scheduledFor.getTime() > MAX_LATENESS_MINUTES[actionType] * 60_000;
}

// ── Morning Brief configuration ──────────────────────────────────────────────

export const BRIEF_BLOCKS = [
  "calendar",
  "email",
  "needs_reply",
  "tasks",
  "habits",
  "goals",
  "finance",
  "news",
] as const;
/** Finance is personal and News needs topics: both are opt-in. */
export const DEFAULT_BRIEF_BLOCKS = BRIEF_BLOCKS.filter((b) => b !== "finance" && b !== "news");
export type BriefBlock = (typeof BRIEF_BLOCKS)[number];

export const morningBriefConfigSchema = z
  .object({
    blocks: z
      .array(z.enum(BRIEF_BLOCKS))
      .min(1)
      .default([...DEFAULT_BRIEF_BLOCKS])
      .transform((b) => [...new Set(b)]),
    /**
     * Which accounts to read per capability: "all" resolves the enabled accounts at run time;
     * a connection id pins that account (and never falls back to another one).
     */
    sources: z
      .object({
        calendar: z.union([z.literal("all"), z.uuid()]).default("all"),
        email: z.union([z.literal("all"), z.uuid()]).default("all"),
        tasks: z.union([z.literal("all"), z.uuid()]).default("all"),
      })
      .strict()
      .default({ calendar: "all", email: "all", tasks: "all" }),
    /**
     * News block (ADR-015): the topics to follow, comma-separated ("AI, Power Automate,
     * UiPath"). Only these — never inferred interests.
     */
    newsTopics: z.string().trim().max(300).default(""),
  })
  .strict();

export type MorningBriefConfig = z.infer<typeof morningBriefConfigSchema>;

export const deliverySchema = z
  .object({ notify: z.enum(["none", "in_app", "browser"]).default("in_app") })
  .strict();

export type Delivery = z.infer<typeof deliverySchema>;

export { briefCapabilities } from "./brief-capabilities";

/** Everything a user (or ELISE from chat) submits to create or edit a Schedule. */
export const scheduleInputSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    actionType: z.literal("morning_brief"),
    definition: scheduleDefinitionSchema,
    timezone: timezoneSchema,
    configuration: morningBriefConfigSchema,
    instructions: z.string().trim().max(2000).nullable().default(null),
    delivery: deliverySchema.default({ notify: "in_app" }),
  })
  .strict();

export type ScheduleInput = z.infer<typeof scheduleInputSchema>;

export type ScheduleStatus = "active" | "paused" | "needs_attention" | "completed" | "archived";
export type RunStatus =
  | "queued"
  | "running"
  | "waiting_for_approval"
  | "completed"
  | "completed_with_warning"
  | "failed"
  | "cancelled"
  | "missed"
  | "skipped";

/** The topics of a News block: up to four, trimmed, de-duplicated. */
export function newsTopics(config: MorningBriefConfig): string[] {
  return [
    ...new Set(
      config.newsTopics
        .split(/[,;\n]/)
        .map((t) => t.trim())
        .filter((t) => t.length >= 2),
    ),
  ].slice(0, 4);
}

import { z } from "zod";

import type { ToolDefinition } from "../agents/tools";
import { AppError } from "../errors";
import {
  BRIEF_BLOCKS,
  briefCapabilities,
  nextOccurrence,
  scheduleInputSchema,
  type ScheduleInput,
} from "../schedules/schedule";
import { isIsoDate, toLocalDateTime } from "../time";

const proposeInput = z
  .object({
    name: z.string().trim().min(1).max(120).default("Morning Brief"),
    days: z
      .array(z.number().int().min(0).max(6))
      .min(1)
      .max(7)
      .optional()
      .describe("Recurring: weekdays 0=Sun…6=Sat. Weekdays = [1,2,3,4,5]; every day = all seven."),
    date: z
      .string()
      .refine(isIsoDate, "Expected YYYY-MM-DD")
      .optional()
      .describe("One-time: the local date. Use instead of days."),
    time: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
      .describe("Local time HH:mm (24 h) in the user's timezone."),
    blocks: z
      .array(z.enum(BRIEF_BLOCKS))
      .min(1)
      .optional()
      .describe("What to include. Omit for the default: calendar, email, needs_reply, tasks."),
    notify: z.enum(["none", "in_app", "browser"]).default("in_app"),
    instructions: z
      .string()
      .trim()
      .max(2000)
      .optional()
      .describe('The user\'s own words about content, e.g. "Ignore newsletters".'),
  })
  .strict();

/**
 * Turns a natural-language request ("every weekday at 7:30 prepare my Morning Brief") into a
 * structured Schedule proposal. Creates nothing: the user confirms on the card
 * (docs/architecture/13 §23, §62).
 */
export const proposeScheduleTool: ToolDefinition = {
  name: "schedules.propose",
  capability: "schedules",
  operation: "propose",
  description:
    "Propose a Schedule (today: a Morning Brief) from the user's request. Shows a confirmation card; nothing is created until the user presses Create. Resolve times to the user's local time. If the time is vague (\"in the morning\"), ask first.",
  input: proposeInput,
  async describe() {
    return { summary: "Propose schedule" };
  },
  async run(raw, env) {
    const p = proposeInput.parse(raw);
    if (!p.days && !p.date)
      throw new AppError("VALIDATION_ERROR", "Give either days (recurring) or a date (one-time)", {
        recovery: "review",
      });
    const parsed = scheduleInputSchema.safeParse({
      name: p.name,
      actionType: "morning_brief",
      definition: p.date
        ? { kind: "once", at: `${p.date}T${p.time}` }
        : { kind: "weekly", days: p.days, time: p.time },
      timezone: env.ctx.timezone,
      configuration: { blocks: p.blocks ?? [...BRIEF_BLOCKS] },
      instructions: p.instructions ?? null,
      delivery: { notify: p.notify },
    });
    if (!parsed.success) {
      throw new AppError("VALIDATION_ERROR", parsed.error.issues.map((i) => i.message).join("; "), {
        recovery: "review",
      });
    }
    const input: ScheduleInput = parsed.data;
    const next = nextOccurrence(input.definition, input.timezone, env.ctx.now);
    if (!next)
      throw new AppError("VALIDATION_ERROR", "That time is already in the past", {
        recovery: "review",
      });
    return {
      output: {
        proposal: {
          name: input.name,
          when: input.definition,
          timezone: input.timezone,
          uses: briefCapabilities(input.configuration),
          firstRun: toLocalDateTime(next, input.timezone),
        },
        note: "A confirmation card is shown. Nothing is created until the user presses Create; say so briefly.",
      },
      display: { kind: "schedule_proposal", input, nextRunAt: next.toISOString() },
    };
  },
};

export const SCHEDULE_TOOLS = [proposeScheduleTool];

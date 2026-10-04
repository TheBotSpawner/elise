import type { BriefBlock, BriefHorizon, ScheduleDefinition, SchedulePreset } from "./schedule";

/**
 * Scheduled-task presets (ADR-037): each one only prefills the one canonical schedule — what
 * ELISE looks at, which days, when. Names and instructions are written in the user's language
 * by the UI, and become ordinary, editable fields. No preset has a table, service or handler.
 */
export interface PresetSpec {
  id: SchedulePreset;
  blocks: BriefBlock[];
  horizon: BriefHorizon;
  definition: ScheduleDefinition;
  /** The preset can't be created until the user picks something (a Knowledge Space). */
  needsSpace?: boolean;
}

const WEEKDAYS = [1, 2, 3, 4, 5];

export const PRESETS: readonly PresetSpec[] = [
  {
    id: "morning_brief",
    blocks: ["calendar", "email", "needs_reply", "tasks", "habits", "goals"],
    horizon: "today",
    definition: { kind: "weekly", days: WEEKDAYS, time: "07:30" },
  },
  {
    id: "weekly_planning",
    blocks: ["calendar", "tasks", "goals"],
    horizon: "week",
    definition: { kind: "weekly", days: [0], time: "19:00" },
  },
  {
    id: "end_of_day",
    blocks: ["calendar", "tasks", "habits", "email"],
    horizon: "today",
    definition: { kind: "weekly", days: WEEKDAYS, time: "18:30" },
  },
  {
    id: "calendar_prep",
    blocks: ["calendar"],
    horizon: "tomorrow",
    definition: { kind: "weekly", days: [0, 1, 2, 3, 4], time: "20:00" },
  },
  {
    id: "task_review",
    blocks: ["tasks"],
    horizon: "today",
    definition: { kind: "weekly", days: WEEKDAYS, time: "09:00" },
  },
  {
    id: "email_follow_up",
    blocks: ["needs_reply", "email"],
    horizon: "today",
    definition: { kind: "weekly", days: WEEKDAYS, time: "16:00" },
  },
  {
    id: "knowledge_digest",
    blocks: ["knowledge"],
    horizon: "week",
    definition: { kind: "weekly", days: [5], time: "17:00" },
    needsSpace: true,
  },
  {
    id: "habit_check_in",
    blocks: ["habits", "goals"],
    horizon: "today",
    definition: { kind: "weekly", days: [0, 1, 2, 3, 4, 5, 6], time: "20:30" },
  },
];

/**
 * Which preset an existing schedule came from. Schedules from before presets (and chat
 * proposals without one) are Morning Briefs only when they look like one: today's calendar,
 * no Knowledge block.
 */
export function presetOf(config: {
  preset?: SchedulePreset | null;
  horizon?: BriefHorizon;
  blocks: readonly BriefBlock[];
}): SchedulePreset | null {
  if (config.preset) return config.preset;
  const legacy =
    (config.horizon ?? "today") === "today" &&
    config.blocks.includes("calendar") &&
    !config.blocks.includes("knowledge");
  return legacy ? "morning_brief" : null;
}

import { z } from "zod";

import { THEMES } from "../capabilities/settings";
import { nameKey } from "../contexts/model";
import { AppError } from "../errors";
import { STUDY_MODES } from "../study/model";
import { addDays } from "../time";

/**
 * ELISE Shortcuts (ADR-017 §10-13): a user-defined trigger for workflows ELISE already has.
 * Not voice-only — the same Shortcut runs from a phrase, from My Elise, or from chat. Steps are
 * typed and allowlisted; each maps to existing tools that run through the normal executor, so
 * a Shortcut never grants authority, bypasses approvals or reaches anything new.
 */

const context = z.string().trim().min(1).max(120);

/** The allowlist: step type → its parameters → the tool call(s) it becomes. */
export const STEP_TYPES = {
  "morning_brief.run": z.object({}).strict(),
  "daily_planning.start": z.object({ context: context.optional() }).strict(),
  "meeting.prepare_next": z.object({}).strict(),
  "study.start": z
    .object({
      context: context.optional(),
      mode: z.enum(STUDY_MODES).default("oral_exam"),
      units: z.array(z.string().trim().min(1).max(20)).max(8).optional(),
      topics: z.array(z.string().trim().min(2).max(80)).max(6).optional(),
    })
    .strict(),
  "work.brief": z.object({ context: context.optional(), web: z.boolean().default(false) }).strict(),
  "tasks.show_today": z.object({}).strict(),
  "calendar.show_today": z.object({}).strict(),
  "finance.show_summary": z
    .object({ period: z.enum(["this_month", "last_month", "this_week"]).default("this_month") })
    .strict(),
  "context.activate": z.object({ context: context.optional() }).strict(),
  "workspace.clear": z.object({}).strict(),
  "appearance.set_theme": z.object({ theme: z.enum(THEMES) }).strict(),
} as const;

export type StepType = keyof typeof STEP_TYPES;
export const STEP_TYPE_KEYS = Object.keys(STEP_TYPES) as StepType[];

export interface ShortcutStep {
  type: StepType;
  config: Record<string, unknown>;
}

export interface Shortcut {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  phrases: string[];
  language: "es" | "en" | null;
  steps: ShortcutStep[];
  /** Used by steps that need a context and don't name one ("Client A Brief" → Client A). */
  contextId: string | null;
  requiresConfirmation: boolean;
  lastRunAt: string | null;
  runCount: number;
}

export interface NewShortcut {
  name: string;
  description?: string | null;
  phrases: string[];
  language?: "es" | "en" | null;
  steps: ShortcutStep[];
  contextId?: string | null;
  requiresConfirmation?: boolean;
}

/** Persistence port (the author's own rows, RLS). */
export interface ShortcutStore {
  list(): Promise<Shortcut[]>;
  create(input: NewShortcut): Promise<Shortcut>;
  update(id: string, patch: Partial<NewShortcut> & { enabled?: boolean }): Promise<Shortcut>;
  remove(id: string): Promise<void>;
  markRun(id: string): Promise<void>;
}

export const SHORTCUT_LIMITS = { steps: 4, phrases: 5, phraseChars: 60 } as const;

const stepSchema = z
  .object({ type: z.enum(STEP_TYPE_KEYS as [StepType, ...StepType[]]), config: z.unknown() })
  .strict();

/** Validates steps against the allowlist; unknown types and parameters are refused. */
export function parseSteps(raw: unknown): ShortcutStep[] {
  const steps = z.array(stepSchema).min(1).max(SHORTCUT_LIMITS.steps).parse(raw);
  return steps.map((s) => ({
    type: s.type,
    config: STEP_TYPES[s.type].parse(s.config ?? {}) as Record<string, unknown>,
  }));
}

/** A phrase in its matching form: lowercase, no accents, no punctuation, single spaces. */
export function phraseKey(phrase: string): string {
  return nameKey(phrase)
    .replace(/[^a-z0-9ñ ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function validatePhrases(phrases: string[]): string[] {
  const clean = [...new Set(phrases.map((p) => p.trim().replace(/\s+/g, " ")).filter(Boolean))];
  const invalid = (m: string) => new AppError("VALIDATION_ERROR", m, { recovery: "review" });
  if (!clean.length) throw invalid("A shortcut needs at least one phrase");
  if (clean.length > SHORTCUT_LIMITS.phrases) throw invalid("At most 5 phrases");
  for (const p of clean) {
    const key = phraseKey(p);
    if (key.length < 3 || p.length > SHORTCUT_LIMITS.phraseChars)
      throw invalid(`"${p}" is too short or too long for a phrase`);
  }
  return clean;
}

export interface ToolCallPlan {
  name: string;
  args: Record<string, unknown>;
}

/**
 * Steps → the existing tools they run. `contextId` fills a step that needs a context and
 * didn't name one. Dates are the user's local today.
 */
export function stepsToCalls(
  steps: ShortcutStep[],
  opts: { contextId: string | null; today: string },
): ToolCallPlan[] {
  return steps.map((s): ToolCallPlan => {
    const c = s.config as Record<string, unknown>;
    const ctx = (c.context as string | undefined) ?? opts.contextId ?? undefined;
    switch (s.type) {
      case "morning_brief.run":
        return { name: "briefs.today", args: {} };
      case "daily_planning.start":
        return { name: "planning.today", args: ctx ? { context: ctx } : {} };
      case "meeting.prepare_next":
        return { name: "meeting.prepare", args: {} };
      case "study.start":
        return {
          name: "study.start",
          args: {
            ...(ctx ? { context: ctx } : {}),
            mode: c.mode ?? "oral_exam",
            ...(c.units || c.topics
              ? {
                  scope: {
                    ...(c.units ? { units: c.units } : {}),
                    ...(c.topics ? { topics: c.topics } : {}),
                  },
                }
              : {}),
          },
        };
      case "work.brief":
        return {
          name: "work.brief",
          args: { ...(ctx ? { context: ctx } : {}), web: Boolean(c.web) },
        };
      case "tasks.show_today":
        return { name: "tasks.list", args: { status: "open", due: "today", limit: 50 } };
      case "calendar.show_today":
        return {
          name: "calendar.listEvents",
          args: { from: opts.today, to: addDays(opts.today, 1), limit: 50 },
        };
      case "finance.show_summary":
        return { name: "finance.getSummary", args: { period: c.period ?? "this_month" } };
      case "context.activate":
        return { name: "contexts.activate", args: { context: ctx ?? "" } };
      case "workspace.clear":
        return { name: "ui.clear", args: {} };
      case "appearance.set_theme":
        return { name: "appearance.setTheme", args: { theme: c.theme } };
    }
  });
}

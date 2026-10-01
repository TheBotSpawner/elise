import { z } from "zod";

import { findProfile } from "./contexts";
import type { ToolDefinition, ToolRunEnv } from "../agents/tools";
import type { ContextStore } from "../contexts/model";
import { AppError } from "../errors";
import { phraseConflicts } from "../shortcuts/match";
import {
  parseSteps,
  phraseKey,
  STEP_TYPE_KEYS,
  stepsToCalls,
  validatePhrases,
  type Shortcut,
  type ShortcutStep,
  type ShortcutStore,
} from "../shortcuts/model";
import { todayIn } from "../time";
import type { SurfacePayloads } from "../workspace/registry";

/**
 * ELISE Shortcuts through chat (ADR-017 §13): typed, allowlisted, and confirmed before they
 * exist. "Cuando diga 'arrancamos', mostrame calendario, tareas y hábitos" becomes a proposal
 * with Save — never a free-form automation.
 */

const store = (env: ToolRunEnv): ShortcutStore => env.providers.get("shortcuts", env.binding);
const contexts = (env: ToolRunEnv): ContextStore => env.providers.get("contexts", env.binding);

const ref = z.string().trim().min(1).max(120).describe("The shortcut's name, a phrase, or id.");

async function findShortcut(env: ToolRunEnv, r: string): Promise<Shortcut> {
  const all = await store(env).list();
  const key = phraseKey(r);
  const hits = all.filter(
    (s) => s.id === r || phraseKey(s.name) === key || s.phrases.some((p) => phraseKey(p) === key),
  );
  if (hits.length === 1) return hits[0]!;
  throw new AppError(
    hits.length ? "VALIDATION_ERROR" : "NOT_FOUND",
    hits.length
      ? `Several shortcuts match "${r}". Ask which.`
      : all.length
        ? `No shortcut "${r}". Shortcuts: ${all.map((s) => s.name).join(", ")}`
        : "There are no shortcuts yet.",
    { recovery: "review" },
  );
}

const stepInput = z
  .object({
    type: z.enum(STEP_TYPE_KEYS as [string, ...string[]]),
    config: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const definition = {
  name: z.string().trim().min(1).max(80),
  phrases: z
    .array(z.string().trim().min(3).max(60))
    .min(1)
    .max(5)
    .describe('What the user will say, without the wake phrase: ["arrancamos"].'),
  steps: z
    .array(stepInput)
    .min(1)
    .max(4)
    .describe(
      "Allowlisted steps, in order: morning_brief.run, daily_planning.start {context?}, meeting.prepare_next, study.start {context, mode, units?, topics?}, work.brief {context, web?}, tasks.show_today, calendar.show_today, finance.show_summary {period}, context.activate {context}, workspace.clear, appearance.set_theme {theme}.",
    ),
  context: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .optional()
    .describe('A Context Profile the steps use by default ("RSFA Brief" → RSFA).'),
  requiresConfirmation: z.boolean().default(false),
};

const defineInput = z.object(definition).strict();
type Definition = z.infer<typeof defineInput>;

/** Validated definition: allowlisted steps, sane phrases, a real context, no phrase clash. */
async function validate(env: ToolRunEnv, q: Definition, ignoreId: string | null = null) {
  let phrases: string[];
  let steps: ShortcutStep[];
  try {
    phrases = validatePhrases(q.phrases);
    steps = parseSteps(q.steps.map((s) => ({ type: s.type, config: s.config ?? {} })));
  } catch (error) {
    throw new AppError(
      "VALIDATION_ERROR",
      error instanceof Error ? error.message.slice(0, 300) : "Invalid shortcut",
      { recovery: "review" },
    );
  }
  const profile = q.context ? await findProfile(contexts(env), q.context) : null;
  const clash = phraseConflicts(
    phrases,
    (await store(env).list()).filter((s) => s.id !== ignoreId),
  );
  if (clash.length)
    throw new AppError("CONFLICT", `Another shortcut already uses "${clash[0]}"`, {
      recovery: "review",
    });
  return { phrases, steps, profile };
}

function payload(
  s: { name: string; phrases: string[]; steps: ShortcutStep[]; requiresConfirmation: boolean },
  extra: {
    shortcutId: string | null;
    contextId: string | null;
    contextName: string | null;
    state: SurfacePayloads["shortcut"]["state"];
  },
): SurfacePayloads["shortcut"] {
  return {
    shortcutId: extra.shortcutId,
    name: s.name.slice(0, 80),
    phrases: s.phrases.slice(0, 5),
    steps: s.steps.map((st) => ({ type: st.type, config: st.config })),
    contextId: extra.contextId,
    contextName: extra.contextName,
    requiresConfirmation: s.requiresConfirmation,
    state: extra.state,
  };
}

const forModel = (s: Shortcut) => ({
  id: s.id,
  name: s.name,
  phrases: s.phrases,
  steps: s.steps.map((x) => x.type),
  enabled: s.enabled,
  ...(s.contextId ? { context: s.contextId } : {}),
});

export const listShortcutsTool: ToolDefinition = {
  name: "shortcuts.list",
  capability: "shortcuts",
  operation: "list",
  description: '"¿Qué shortcuts tengo?": the user\'s Shortcuts with their phrases and steps.',
  input: z.object({}).strict(),
  async describe() {
    return { summary: "List shortcuts" };
  },
  async run(_raw, env) {
    return { output: { shortcuts: (await store(env).list()).map(forModel) } };
  },
};

export const proposeShortcutTool: ToolDefinition = {
  name: "shortcuts.propose",
  capability: "shortcuts",
  operation: "propose",
  description:
    "\"Cuando diga 'arrancamos', mostrame mi calendario, tareas y hábitos\": maps the request to allowlisted steps and shows a Shortcut to save. Nothing is saved until the user confirms. If no allowlisted step fits, say so — never invent one.",
  input: defineInput,
  async describe() {
    return { summary: "Propose shortcut" };
  },
  async run(raw, env) {
    const q = defineInput.parse(raw);
    const { phrases, steps, profile } = await validate(env, q);
    const p = payload(
      { name: q.name, phrases, steps, requiresConfirmation: q.requiresConfirmation },
      {
        shortcutId: null,
        contextId: profile?.id ?? null,
        contextName: profile?.name ?? null,
        state: "proposed",
      },
    );
    return {
      output: {
        proposal: {
          name: q.name,
          phrases,
          steps: steps.map((s) => s.type),
          context: profile?.name,
        },
        instructions:
          "The Shortcut is on screen with Save. In one sentence, say what it will do and ask them to save it (or to confirm here — then call shortcuts.create with the same definition).",
      },
      display: { kind: "shortcut", shortcut: p },
    };
  },
};

export const createShortcutTool: ToolDefinition = {
  name: "shortcuts.create",
  capability: "shortcuts",
  operation: "create",
  description:
    "Saves a Shortcut the user confirmed (after shortcuts.propose). Steps run existing tools under their normal permissions and approvals.",
  input: defineInput,
  async describe(raw) {
    return { summary: `Create shortcut “${defineInput.parse(raw).name}”` };
  },
  async run(raw, env) {
    const q = defineInput.parse(raw);
    const { phrases, steps, profile } = await validate(env, q);
    const s = await store(env).create({
      name: q.name,
      phrases,
      steps,
      contextId: profile?.id ?? null,
      requiresConfirmation: q.requiresConfirmation,
      language: env.ctx.locale,
    });
    return {
      output: { created: true, shortcut: forModel(s) },
      display: {
        kind: "shortcut",
        shortcut: payload(s, {
          shortcutId: s.id,
          contextId: s.contextId,
          contextName: profile?.name ?? null,
          state: "saved",
        }),
      },
      target: { type: "shortcut", id: s.id },
    };
  },
};

const updateInput = z
  .object({
    shortcut: ref,
    name: definition.name.optional(),
    phrases: definition.phrases.optional(),
    steps: definition.steps.optional(),
    context: definition.context,
    enabled: z.boolean().optional(),
  })
  .strict();

export const updateShortcutTool: ToolDefinition = {
  name: "shortcuts.update",
  capability: "shortcuts",
  operation: "update",
  description:
    "\"Cambiá 'arrancamos' por 'vamos'\", \"que RSFA Brief también busque en la web\": changes a Shortcut's name, phrases, steps or context.",
  input: updateInput,
  async describe(raw, env) {
    const s = await findShortcut(env, updateInput.parse(raw).shortcut);
    return { summary: `Update shortcut “${s.name}”`, target: { type: "shortcut", id: s.id } };
  },
  async run(raw, env) {
    const q = updateInput.parse(raw);
    const s = await findShortcut(env, q.shortcut);
    const merged: Definition = {
      name: q.name ?? s.name,
      phrases: q.phrases ?? s.phrases,
      steps: (q.steps ?? s.steps) as Definition["steps"],
      requiresConfirmation: s.requiresConfirmation,
      ...(q.context ? { context: q.context } : {}),
    };
    const { phrases, steps, profile } = await validate(env, merged, s.id);
    const updated = await store(env).update(s.id, {
      name: merged.name,
      phrases,
      steps,
      ...(profile ? { contextId: profile.id } : {}),
      ...(q.enabled !== undefined ? { enabled: q.enabled } : {}),
    });
    return {
      output: { updated: true, shortcut: forModel(updated) },
      target: { type: "shortcut", id: s.id },
    };
  },
};

const toggle = (enabled: boolean): ToolDefinition => ({
  name: enabled ? "shortcuts.enable" : "shortcuts.disable",
  capability: "shortcuts",
  operation: enabled ? "enable" : "disable",
  description: enabled
    ? "Turns a Shortcut back on."
    : '"Desactivá Morning Brief": turns a Shortcut off (its phrase stops triggering it).',
  input: z.object({ shortcut: ref }).strict(),
  async describe(raw, env) {
    const s = await findShortcut(env, (raw as { shortcut: string }).shortcut);
    return {
      summary: `${enabled ? "Enable" : "Disable"} shortcut “${s.name}”`,
      target: { type: "shortcut", id: s.id },
    };
  },
  async run(raw, env) {
    const s = await findShortcut(env, (raw as { shortcut: string }).shortcut);
    if (enabled) {
      const clash = phraseConflicts(
        s.phrases,
        (await store(env).list()).filter((x) => x.id !== s.id),
      );
      if (clash.length)
        throw new AppError("CONFLICT", `Another shortcut already uses "${clash[0]}"`, {
          recovery: "review",
        });
    }
    const u = await store(env).update(s.id, { enabled });
    return { output: { shortcut: forModel(u) }, target: { type: "shortcut", id: s.id } };
  },
});

export const deleteShortcutTool: ToolDefinition = {
  name: "shortcuts.delete",
  capability: "shortcuts",
  operation: "delete",
  description: '"Eliminá ese shortcut": deletes a Shortcut (only the Shortcut, nothing it uses).',
  input: z.object({ shortcut: ref }).strict(),
  async describe(raw, env) {
    const s = await findShortcut(env, (raw as { shortcut: string }).shortcut);
    return { summary: `Delete shortcut “${s.name}”`, target: { type: "shortcut", id: s.id } };
  },
  async run(raw, env) {
    const s = await findShortcut(env, (raw as { shortcut: string }).shortcut);
    await store(env).remove(s.id);
    return { output: { deleted: true, name: s.name }, target: { type: "shortcut", id: s.id } };
  },
};

export const runShortcutTool: ToolDefinition = {
  name: "shortcuts.run",
  capability: "shortcuts",
  operation: "run",
  description:
    '"Corré mi shortcut RSFA Brief": what a Shortcut runs. Then call exactly these tools, in order, with these arguments — each still under its own permissions and approvals.',
  input: z.object({ shortcut: ref }).strict(),
  async describe() {
    return { summary: "Run shortcut" };
  },
  async run(raw, env) {
    const s = await findShortcut(env, (raw as { shortcut: string }).shortcut);
    if (!s.enabled)
      return {
        output: { enabled: false, instructions: "This shortcut is off. Ask before turning it on." },
      };
    const calls = stepsToCalls(s.steps, {
      contextId: s.contextId,
      today: todayIn(env.ctx.timezone, env.ctx.now),
    });
    return {
      output: {
        shortcut: s.name,
        run: calls.map((c) => ({ tool: c.name, args: c.args })),
        instructions:
          "Call these tools now, in this order, with exactly these arguments; then answer briefly.",
      },
    };
  },
};

export const SHORTCUT_TOOLS = [
  listShortcutsTool,
  proposeShortcutTool,
  createShortcutTool,
  updateShortcutTool,
  toggle(true),
  toggle(false),
  deleteShortcutTool,
  runShortcutTool,
];

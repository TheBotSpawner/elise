import { z } from "zod";

import type { ToolDefinition, ToolRunEnv } from "../agents/tools";
import {
  ACCENTS,
  resolveTimezone,
  THEMES,
  type ScheduleSummary,
  type SettingsStore,
} from "../capabilities/settings";
import { AppError } from "../errors";
import { NATIVE_MODULES, type NativeModuleKey } from "../modules/registry";
import { VOICE_LANGUAGES } from "../voice/preferences";

/**
 * ELISE Self-Control (ADR-012): ELISE operates its own product settings through these typed
 * tools — never by touching code, prompts or frontend state. Values are allowlisted and
 * validated; every change is a recorded, audited action under the normal policy.
 */

function store(env: ToolRunEnv): SettingsStore {
  return env.providers.get("settings", env.binding);
}

const appearanceDisplay = async (env: ToolRunEnv) => {
  const p = await store(env).get();
  return { kind: "appearance" as const, theme: p.theme, accent: p.accent };
};

export const getSettingsTool: ToolDefinition = {
  name: "settings.get",
  capability: "settings",
  operation: "get",
  description: "The user's ELISE settings: language, time zone, theme and accent color.",
  input: z.object({}).strict(),
  async describe() {
    return { summary: "Read settings" };
  },
  async run(_raw, env) {
    const p = await store(env).get();
    return {
      output: { language: p.language, timezone: p.timezone, theme: p.theme, accent: p.accent },
    };
  },
};

const updateInput = z
  .object({
    language: z.enum(["es", "en"]).optional(),
    timezone: z
      .string()
      .trim()
      .min(2)
      .max(80)
      .optional()
      .describe('A city or IANA zone: "Buenos Aires", "America/New_York".'),
  })
  .strict();

export const updateSettingsTool: ToolDefinition = {
  name: "settings.update",
  capability: "settings",
  operation: "update",
  description:
    '"Set my time zone to Buenos Aires", "switch to English": change the user\'s language or time zone. The time zone is resolved to the canonical zone; if ambiguous, the tool says so — ask.',
  input: updateInput,
  // Resolve the time zone before recording, so the action stores the canonical value.
  async pin(raw) {
    const u = updateInput.parse(raw);
    if (!u.language && !u.timezone)
      throw new AppError("VALIDATION_ERROR", "Nothing to change", { recovery: "review" });
    return { ...u, ...(u.timezone ? { timezone: resolveTimezone(u.timezone) } : {}) };
  },
  async describe(raw) {
    const u = updateInput.parse(raw);
    return {
      summary: [u.language && `Language → ${u.language}`, u.timezone && `Time zone → ${u.timezone}`]
        .filter(Boolean)
        .join(", "),
    };
  },
  async run(raw, env) {
    const u = updateInput.parse(raw);
    const before = await store(env).get();
    const p = await store(env).update({
      ...(u.language ? { language: u.language } : {}),
      ...(u.timezone ? { timezone: resolveTimezone(u.timezone) } : {}),
    });
    const changes = [
      ...(u.language
        ? [{ setting: "language" as const, from: before.language, to: p.language }]
        : []),
      ...(u.timezone
        ? [{ setting: "timezone" as const, from: before.timezone, to: p.timezone }]
        : []),
    ];
    return {
      output: { updated: true, language: p.language, timezone: p.timezone },
      display: { kind: "setting_changed", changes },
    };
  },
};

export const getAppearanceTool: ToolDefinition = {
  name: "appearance.get",
  capability: "settings",
  operation: "getAppearance",
  description: "ELISE's current theme (system/dark/light) and accent color.",
  input: z.object({}).strict(),
  async describe() {
    return { summary: "Read appearance" };
  },
  async run(_raw, env) {
    const d = await appearanceDisplay(env);
    return { output: { theme: d.theme, accent: d.accent, accents: ACCENTS } };
  },
};

const themeInput = z.object({ theme: z.enum(THEMES) }).strict();

export const setThemeTool: ToolDefinition = {
  name: "appearance.setTheme",
  capability: "settings",
  operation: "setTheme",
  description: '"Switch to light mode", "dark mode", "follow the system": set ELISE\'s theme.',
  input: themeInput,
  confirm(output, locale) {
    const theme = (output as { theme: string }).theme;
    return locale === "es"
      ? `Listo, cambié al modo ${THEME_ES[theme] ?? theme}.`
      : `Done — switched to ${theme} mode.`;
  },
  async describe(raw) {
    return { summary: `Theme → ${themeInput.parse(raw).theme}` };
  },
  async run(raw, env) {
    const before = await store(env).get();
    const p = await store(env).update({ theme: themeInput.parse(raw).theme });
    return {
      output: { theme: p.theme },
      display: {
        kind: "appearance",
        theme: p.theme,
        accent: p.accent,
        previous: { theme: before.theme, accent: before.accent },
      },
    };
  },
};

const ACCENT_ES: Record<string, string> = {
  cyan: "cian",
  blue: "azul",
  violet: "violeta",
  green: "verde",
  amber: "ámbar",
};
const THEME_ES: Record<string, string> = { dark: "oscuro", light: "claro", system: "del sistema" };

const accentInput = z
  .object({
    accent: z
      .enum(ACCENTS)
      .describe('One of the approved colors. "Go back to normal/default" → cyan.'),
  })
  .strict();

export const setAccentTool: ToolDefinition = {
  name: "appearance.setAccent",
  capability: "settings",
  operation: "setAccent",
  description: `"Change your color to green": set ELISE's accent. Only these colors exist: ${ACCENTS.join(", ")} (cyan is the default). Any other color: say which ones are available.`,
  input: accentInput,
  confirm(output, locale) {
    const accent = (output as { accent: string }).accent;
    return locale === "es"
      ? `Listo, ahora uso el color ${ACCENT_ES[accent] ?? accent}.`
      : `Done — I'm using ${accent} now.`;
  },
  async describe(raw) {
    return { summary: `Accent → ${accentInput.parse(raw).accent}` };
  },
  async run(raw, env) {
    const before = await store(env).get();
    const p = await store(env).update({ accent: accentInput.parse(raw).accent });
    return {
      output: { accent: p.accent },
      display: {
        kind: "appearance",
        theme: p.theme,
        accent: p.accent,
        previous: { theme: before.theme, accent: before.accent },
      },
    };
  },
};

const scheduleForModel = (s: ScheduleSummary) => ({
  schedule: s.id,
  name: s.name,
  status: s.status,
  ...(s.nextRunAt ? { nextRunAt: s.nextRunAt } : {}),
});

async function pickSchedule(env: ToolRunEnv, ref: string): Promise<ScheduleSummary> {
  const all = await store(env).schedules();
  const n = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
  const exact = all.filter((s) => s.id === ref || n(s.name) === n(ref));
  const matches = exact.length ? exact : all.filter((s) => n(s.name).includes(n(ref)));
  if (matches.length === 1) return matches[0]!;
  throw new AppError(
    matches.length ? "VALIDATION_ERROR" : "NOT_FOUND",
    matches.length
      ? `Several schedules match "${ref}": ${matches.map((s) => s.name).join(", ")}. Ask which one.`
      : `No schedule called "${ref}". Schedules: ${all.map((s) => s.name).join(", ") || "none"}.`,
    { recovery: "review" },
  );
}

export const listSchedulesTool: ToolDefinition = {
  name: "schedules.list",
  capability: "schedules",
  operation: "list",
  description: "The user's Schedules (e.g. Morning Brief) with status and next run.",
  input: z.object({}).strict(),
  async describe() {
    return { summary: "List schedules" };
  },
  async run(_raw, env) {
    return { output: { schedules: (await store(env).schedules()).map(scheduleForModel) } };
  },
};

const scheduleRef = z
  .object({ schedule: z.string().trim().min(1).max(120).describe("Schedule name or id.") })
  .strict();

function pauseTool(name: "pause" | "resume"): ToolDefinition {
  return {
    name: `schedules.${name}`,
    capability: "schedules",
    operation: name,
    description:
      name === "pause"
        ? '"Pause my Morning Brief": no runs until resumed; nothing is deleted.'
        : '"Resume my Morning Brief".',
    input: scheduleRef,
    async describe(raw, env) {
      const s = await pickSchedule(env, scheduleRef.parse(raw).schedule);
      return {
        summary: `${name === "pause" ? "Pause" : "Resume"} “${s.name}”`,
        target: { type: "schedule", id: s.id },
      };
    },
    async run(raw, env) {
      const s = await pickSchedule(env, scheduleRef.parse(raw).schedule);
      await store(env).setSchedulePaused(s.id, name === "pause");
      return {
        display: {
          kind: "setting_changed",
          changes: [
            {
              setting: "schedule",
              from: s.status,
              to: name === "pause" ? "paused" : "active",
              subject: s.name,
            },
          ],
        },
        output: { [name === "pause" ? "paused" : "resumed"]: s.name },
        target: { type: "schedule", id: s.id },
      };
    },
  };
}

export const listConnectionsTool: ToolDefinition = {
  name: "connections.list",
  capability: "settings",
  operation: "listConnections",
  description:
    '"Which Google accounts are connected?": connected accounts, their status and what ELISE may use. Read-only; disconnecting is done by the user in Connections.',
  input: z.object({}).strict(),
  async describe() {
    return { summary: "List connections" };
  },
  async run(_raw, env) {
    return { output: { connections: await store(env).connections() } };
  },
};

const voiceInput = z
  .object({
    continuous: z
      .boolean()
      .optional()
      .describe('Continuous conversation: keep listening between replies (and answer to "Elise").'),
    language: z.enum(VOICE_LANGUAGES).optional().describe("Voice language: auto, es or en."),
  })
  .strict();

const onOff = (b: boolean) => (b ? "on" : "off");

/**
 * Voice (ADR-068): the same two settings the Voice page has. The wake phrase is always
 * "Elise" — any other phrase isn't supported.
 */
export const updateVoiceTool: ToolDefinition = {
  name: "voice.update",
  capability: "settings",
  operation: "updateVoice",
  description:
    '"Desactivá la conversación continua", "activá la conversación continua", "hablame en inglés": continuous conversation (ELISE keeps listening between replies; "Elise" wakes a resting session in an open tab) and the voice language. The wake phrase is always "Elise" — another phrase isn\'t supported, say so. Hearing "Elise" with the app closed or the screen locked isn\'t possible on the web — never promise it.',
  input: voiceInput,
  async describe(raw) {
    const q = voiceInput.parse(raw);
    return {
      summary: [
        q.continuous !== undefined && `Continuous conversation ${onOff(q.continuous)}`,
        q.language && `Voice language → ${q.language}`,
      ]
        .filter(Boolean)
        .join(", "),
    };
  },
  async run(raw, env) {
    const q = voiceInput.parse(raw);
    if (q.continuous === undefined && !q.language)
      throw new AppError("VALIDATION_ERROR", "Nothing to change", { recovery: "review" });
    const before = await store(env).voice();
    const after = await store(env).updateVoice(q);
    return {
      output: { updated: true, continuous: after.continuous, language: after.language },
      display: {
        kind: "setting_changed",
        changes: [
          ...(q.continuous !== undefined
            ? [
                {
                  setting: "continuous" as const,
                  from: onOff(before.continuous),
                  to: onOff(after.continuous),
                },
              ]
            : []),
          ...(q.language
            ? [{ setting: "voice_language" as const, from: before.language, to: after.language }]
            : []),
        ],
      },
    };
  },
};

// ── Memory (ADR-068) ─────────────────────────────────────────────────────────

export const listMemoryTool: ToolDefinition = {
  name: "memory.list",
  capability: "settings",
  operation: "listMemory",
  description:
    '"¿Qué sabés de mí?", "¿qué recordás?": the facts in the user\'s Memory, and whether Memory is on. Memory is stable preferences and facts about the user — not past conversations (that is Recall) nor their documents (Knowledge).',
  input: z.object({}).strict(),
  async describe() {
    return { summary: "Read Memory" };
  },
  async run(_raw, env) {
    const m = await store(env).memory();
    return {
      output: {
        enabled: m.enabled,
        facts: m.facts.map((f) => ({
          id: f.id,
          key: f.key,
          value: f.value,
          confidence: f.confidence,
        })),
      },
    };
  },
};

const rememberInput = z
  .object({
    key: z
      .string()
      .trim()
      .min(2)
      .max(60)
      .describe('Short stable key, dotted: "trabajo.horario", "respuestas.formato".'),
    value: z.string().trim().min(1).max(300).describe("The fact, in one short sentence."),
    stated: z
      .boolean()
      .describe("True when the user said it explicitly; false when you inferred it."),
  })
  .strict();

export const rememberTool: ToolDefinition = {
  name: "memory.remember",
  capability: "settings",
  operation: "remember",
  description:
    'Save one stable fact or preference about the user to Memory: "acordate que trabajo de 9 a 18", "prefiero respuestas cortas", "mi socia se llama Ana". Only durable things that help later — never one-off details, secrets, passwords, card numbers, health or other sensitive data unless the user explicitly asks. Not what Settings holds (language, time zone) nor how to do a task (that is a Method). Saving the same key again updates it.',
  input: rememberInput,
  async describe(raw) {
    return { summary: `Remember ${rememberInput.parse(raw).key}` };
  },
  confirm(output, locale) {
    const o = output as { kept?: boolean };
    if (o.kept) return locale === "es" ? "Lo tengo en cuenta." : "Noted.";
    return locale === "es" ? "Listo, lo guardé en tu memoria." : "Done, it's in your Memory.";
  },
  async run(raw, env) {
    const q = rememberInput.parse(raw);
    const r = await store(env).remember({
      key: q.key,
      value: q.value,
      confidence: q.stated ? "stated" : "inferred",
      conversationId: env.ctx.conversationId ?? null,
    });
    return {
      output: {
        saved: !r.kept,
        kept: r.kept,
        key: r.fact.key,
        value: r.fact.value,
        ...(r.replaced ? { replaced: r.replaced.value } : {}),
        ...(r.kept
          ? { note: "The user said something different before; it was kept. Ask if it changed." }
          : {}),
      },
      display: {
        kind: "setting_changed",
        changes: [
          {
            setting: "memory",
            from: r.replaced?.value ?? null,
            to: r.fact.value,
            subject: r.fact.key,
          },
        ],
      },
    };
  },
};

const forgetInput = z
  .object({
    fact: z.string().trim().min(1).max(100).describe("The fact's id or key from memory.list."),
  })
  .strict();

export const forgetTool: ToolDefinition = {
  name: "memory.forget",
  capability: "settings",
  operation: "forget",
  description:
    '"Olvidate de eso", "borrá lo que sabés de mi horario": removes a fact from Memory (memory.list first for its id or key).',
  input: forgetInput,
  async describe(raw) {
    return { summary: `Forget ${forgetInput.parse(raw).fact}` };
  },
  async run(raw, env) {
    const { fact } = forgetInput.parse(raw);
    const removed = await store(env).forget(fact);
    if (!removed)
      throw new AppError("NOT_FOUND", "No memory matches that. Use memory.list.", {
        recovery: "review",
      });
    return { output: { forgotten: removed } };
  },
};

// ── Mi ELISE (ADR-064) ───────────────────────────────────────────────────────

const moduleKeys = z
  .array(z.enum(NATIVE_MODULES.map((m) => m.key) as [NativeModuleKey, ...NativeModuleKey[]]))
  .min(1)
  .max(NATIVE_MODULES.length);

export const listModulesTool: ToolDefinition = {
  name: "modules.list",
  capability: "settings",
  operation: "listModules",
  description:
    "Which Mi ELISE modules (Tareas, Hábitos, Listas, Objetivos, Notas, Finanzas) the user has on. Turning one off keeps its data.",
  input: z.object({}).strict(),
  async describe() {
    return { summary: "List Mi ELISE modules" };
  },
  async run(_raw, env) {
    return { output: { modules: await store(env).modules() } };
  },
};

function moduleTool(on: boolean): ToolDefinition {
  const input = z.object({ modules: moduleKeys }).strict();
  return {
    name: on ? "modules.enable" : "modules.disable",
    capability: "settings",
    operation: "setModules",
    description: on
      ? '"Activame Hábitos", "quiero empezar a usar Finanzas", or yes to your offer: turns Mi ELISE modules on. Their earlier data comes back as it was. Only when the user clearly asks or accepts.'
      : '"Sacá Finanzas de Mi ELISE": turns modules off. Nothing is deleted; ELISE stops using them until they are turned on again. Only on a clear request — "no uso mucho finanzas" is not one.',
    input,
    async describe(raw) {
      const { modules } = input.parse(raw);
      return { summary: `${on ? "Turn on" : "Turn off"} ${modules.join(", ")} in Mi ELISE` };
    },
    confirm(output, locale) {
      const names = (output as { modules: string[] }).modules.join(", ");
      return locale === "es"
        ? on
          ? `Listo. Activé ${names} en Mi ELISE.`
          : `Listo. Saqué ${names} de Mi ELISE. Tus datos siguen guardados.`
        : on
          ? `Done. ${names} is on in My ELISE.`
          : `Done. ${names} is off in My ELISE. Your data is still saved.`;
    },
    async run(raw, env) {
      const { modules } = input.parse(raw);
      await store(env).setModules(Object.fromEntries(modules.map((m) => [m, on])));
      return {
        output: { modules, enabled: on },
        display: {
          kind: "setting_changed",
          changes: modules.map((m) => ({
            setting: "module" as const,
            from: on ? "off" : "on",
            to: on ? "on" : "off",
            subject: m,
          })),
        },
      };
    },
  };
}

export const enableModulesTool = moduleTool(true);
export const disableModulesTool = moduleTool(false);

export const SETTINGS_TOOLS = [
  getSettingsTool,
  updateSettingsTool,
  getAppearanceTool,
  setThemeTool,
  setAccentTool,
  listSchedulesTool,
  pauseTool("pause"),
  pauseTool("resume"),
  listConnectionsTool,
  updateVoiceTool,
  listMemoryTool,
  rememberTool,
  forgetTool,
  listModulesTool,
  enableModulesTool,
  disableModulesTool,
];

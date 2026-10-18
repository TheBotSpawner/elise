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
import { PERSONALITIES, PERSONALITY_NAMES, type ElisePersonality } from "../personality";
import {
  DEFAULT_VOICE,
  nextVoice,
  VOICE_KEYS,
  voiceForModel,
  voiceOf,
  type VoiceKey,
} from "../voice/catalog";
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
  description:
    "The user's ELISE settings: language, time zone, theme, accent color and ELISE's personality.",
  input: z.object({}).strict(),
  async describe() {
    return { summary: "Read settings" };
  },
  async run(_raw, env) {
    const p = await store(env).get();
    const personality = await store(env).personality();
    return {
      output: {
        language: p.language,
        timezone: p.timezone,
        theme: p.theme,
        accent: p.accent,
        personality: PERSONALITY_NAMES[personality].en,
      },
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

// ── The voice (ADR-030) ──────────────────────────────────────────────────────

/** Who speaks (voice identity) — never how loudly or in which language: those are separate. */
const VOICE_IDENTITY_NOTE =
  'Voice identity only: whispering, volume, speed or language ("susurrá", "hablá más bajo", "hablame en inglés") are not a voice change — never call this for them. "Martín, susurrá" → switch to Martín; the whisper is handled by itself.';

const voiceEntry = (key: VoiceKey, current: VoiceKey) => ({
  ...voiceForModel(key),
  ...(key === current ? { current: true } : {}),
  ...(key === DEFAULT_VOICE ? { default: true } : {}),
});

const voiceNames = (keys: readonly VoiceKey[]) => keys.map((k) => voiceOf(k).name).join(", ");

export const getVoiceTool: ToolDefinition = {
  name: "voice.getCurrent",
  capability: "settings",
  operation: "getVoice",
  description: '"¿Qué voz estás usando?": ELISE\'s current voice.',
  input: z.object({}).strict(),
  async describe() {
    return { summary: "Read the voice" };
  },
  async run(_raw, env) {
    const { current } = await store(env).voices();
    return { output: { voice: voiceEntry(current, current) } };
  },
};

export const listVoicesTool: ToolDefinition = {
  name: "voice.listAvailable",
  capability: "settings",
  operation: "listVoices",
  description:
    '"¿Qué voces tenés?": the voices that can be chosen now, with their traits. Only these exist.',
  input: z.object({}).strict(),
  async describe() {
    return { summary: "List voices" };
  },
  async run(_raw, env) {
    const { current, available } = await store(env).voices();
    return { output: { voices: available.map((k) => voiceEntry(k, current)) } };
  },
};

interface VoiceChange {
  voice: ReturnType<typeof voiceForModel>;
  changed: boolean;
}

async function switchVoice(env: ToolRunEnv, current: VoiceKey, key: VoiceKey) {
  const after = key === current ? current : await store(env).setVoice(key);
  const output: VoiceChange = { voice: voiceForModel(after), changed: after !== current };
  return {
    output,
    display: {
      kind: "setting_changed" as const,
      changes: [
        { setting: "voice" as const, from: voiceOf(current).name, to: voiceOf(after).name },
      ],
    },
  };
}

const confirmVoice = (output: unknown, locale: "es" | "en") => {
  const { voice, changed } = output as VoiceChange;
  return locale === "es"
    ? changed
      ? `Listo, ahora uso la voz de ${voice.name}.`
      : `Ya estoy usando la voz de ${voice.name}.`
    : changed
      ? `Done — I'm using ${voice.name}'s voice now.`
      : `I'm already using ${voice.name}'s voice.`;
};

const setVoiceInput = z
  .object({
    voiceKey: z
      .enum(VOICE_KEYS)
      .describe(
        'A voice by name ("poné a Martín", "usá Adriana"), or the best match for what the user described, from the traits in context. "Tu voz", "la original", "la de ELISE" → elise.',
      ),
  })
  .strict();

export const setVoiceTool: ToolDefinition = {
  name: "voice.set",
  capability: "settings",
  operation: "setVoice",
  description: `"Poné a Martín", "volvé a tu voz original", "una voz masculina", "una mujer con voz más grave": set ELISE's voice — the same choice as Settings › Voz, used from the next spoken sentence on, typed or spoken. Only the voices in context exist; for a type that doesn't, say so and offer the closest. ${VOICE_IDENTITY_NOTE}`,
  input: setVoiceInput,
  confirm: confirmVoice,
  async describe(raw) {
    return { summary: `Voice → ${voiceOf(setVoiceInput.parse(raw).voiceKey).name}` };
  },
  async run(raw, env) {
    const { voiceKey } = setVoiceInput.parse(raw);
    const { current, available } = await store(env).voices();
    if (!available.includes(voiceKey))
      throw new AppError(
        "VALIDATION_ERROR",
        `${voiceOf(voiceKey).name} isn't available. Voices available: ${voiceNames(available)}.`,
        { recovery: "review" },
      );
    return switchVoice(env, current, voiceKey);
  },
};

const nextVoiceInput = z
  .object({
    gender: z
      .enum(["female", "male"])
      .optional()
      .describe('Only when the user asked for one: "masculina", "otra voz femenina".'),
    lower: z.boolean().optional().describe('"Más grave", "más baja de tono" (pitch, not volume).'),
  })
  .strict();

export const nextVoiceTool: ToolDefinition = {
  name: "voice.next",
  capability: "settings",
  operation: "setVoice",
  description: `"Cambiá la voz", "probemos otra voz", "poné la otra voz femenina": the next available voice, decided by ELISE in a fixed order — never ask which one. Narrow it with gender/lower when the user gave them. ${VOICE_IDENTITY_NOTE}`,
  input: nextVoiceInput,
  confirm: confirmVoice,
  async describe(raw) {
    const q = nextVoiceInput.parse(raw);
    return { summary: ["Next voice", q.gender, q.lower && "lower"].filter(Boolean).join(" · ") };
  },
  async run(raw, env) {
    const criteria = nextVoiceInput.parse(raw);
    const { current, available } = await store(env).voices();
    const key = nextVoice(current, available, criteria);
    if (key) return switchVoice(env, current, key);
    // The current voice is the only match: nothing to change, and that's the answer.
    if (criteria.gender && voiceOf(current).gender === criteria.gender)
      return switchVoice(env, current, current);
    throw new AppError(
      "VALIDATION_ERROR",
      `No other voice matches. Voices available: ${voiceNames(available)}.`,
      { recovery: "review" },
    );
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
    "Which Mi ELISE modules (Tareas, Hábitos, Listas, Objetivos, Notas, Finanzas) show in Mi ELISE. A hidden one keeps its data and its tools work normally.",
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
    name: on ? "modules.show" : "modules.hide",
    capability: "settings",
    operation: "setModules",
    // Visibility only (ADR-070): hidden modules keep their data and every tool keeps working.
    description: on
      ? '"Volvé a mostrar Objetivos en Mi ELISE", "activame Hábitos": shows modules in Mi ELISE navigation again, with all their data as it was. Only when the user clearly asks.'
      : '"Ocultá Finanzas de Mi ELISE", "sacá Objetivos del menú": hides modules from Mi ELISE navigation only. Nothing is deleted and ELISE can still use them when asked. Only on a clear request — "no uso mucho finanzas" is not one.',
    input,
    async describe(raw) {
      const { modules } = input.parse(raw);
      return { summary: `${on ? "Show" : "Hide"} ${modules.join(", ")} in Mi ELISE` };
    },
    confirm(output, locale) {
      const names = (output as { modules: string[] }).modules.join(", ");
      return locale === "es"
        ? on
          ? `Listo. ${names} volvió a Mi ELISE.`
          : `Listo. Oculté ${names} de Mi ELISE; tus datos siguen ahí.`
        : on
          ? `Done. ${names} is back in My ELISE.`
          : `Done. ${names} is hidden from My ELISE; your data is still there.`;
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

// ── Personality (ADR-076) ────────────────────────────────────────────────────

const personalityInput = z
  .object({
    personality: z
      .enum(PERSONALITIES)
      .optional()
      .describe(
        '"Ponete exigente" → demanding; "más motivadora" → motivating; "hablame como una amiga", "más cercana" → friendly; "ponete sarcástica", "modo ácido" → provocative; "volvé a lo normal", "la de siempre", "por defecto" → efficient. Omit it when the user didn\'t say which ("cambiá tu personalidad"): the choices are shown.',
      ),
  })
  .strict();

export const setPersonalityTool: ToolDefinition = {
  name: "settings.setPersonality",
  capability: "settings",
  operation: "setPersonality",
  description:
    'Change ELISE\'s saved base personality — the same choice as Settings › Personalidad, from the next reply on (chat and voice). Only when the user clearly wants it changed ("cambiá tu personalidad a exigente", "quiero que seas más amistosa desde ahora"); a one-off "hoy hablame más tranquila" is not a change: just adapt this conversation. Tone only — it never changes permissions or approvals — and the voice stays the same.',
  input: personalityInput,
  confirm(output, locale) {
    const o = output as { personality?: string; changed?: boolean; choose?: boolean };
    if (o.choose || !o.personality) return null;
    return locale === "es"
      ? o.changed
        ? `Listo. Ahora estoy en modo ${o.personality}.`
        : `Ya estoy en modo ${o.personality}.`
      : o.changed
        ? `Done. I'm in ${o.personality} mode now.`
        : `I'm already in ${o.personality} mode.`;
  },
  async describe(raw, env) {
    const { personality } = personalityInput.parse(raw);
    return {
      summary: personality
        ? `Personality → ${PERSONALITY_NAMES[personality][env.ctx.locale]}`
        : "Choose a personality",
    };
  },
  async run(raw, env) {
    const { personality } = personalityInput.parse(raw);
    const current = await store(env).personality();
    const name = (p: ElisePersonality) => PERSONALITY_NAMES[p][env.ctx.locale];
    // No target: never guess — the five choices go on screen.
    if (!personality)
      return {
        output: {
          choose: true,
          current: name(current),
          instructions: "The choices are on screen. Ask in a few words which one they want.",
        },
        display: { kind: "personality" as const, current },
      };
    const after = personality === current ? current : await store(env).setPersonality(personality);
    return {
      output: { personality: name(after), changed: after !== current },
      display: {
        kind: "setting_changed" as const,
        changes: [{ setting: "personality" as const, from: name(current), to: name(after) }],
      },
    };
  },
};

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
  getVoiceTool,
  listVoicesTool,
  setVoiceTool,
  nextVoiceTool,
  setPersonalityTool,
  listMemoryTool,
  rememberTool,
  forgetTool,
  listModulesTool,
  enableModulesTool,
  disableModulesTool,
];

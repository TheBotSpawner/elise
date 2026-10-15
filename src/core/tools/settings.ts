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
import { WAKE_LABELS, WAKE_PHRASES } from "../voice/wake";

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

const wakeInput = z
  .object({
    phrase: z
      .enum(WAKE_PHRASES)
      .optional()
      .describe('One of the supported phrases: "elise", "hey_elise", "oye_elise", "liz".'),
    enabled: z.boolean().optional().describe("Turn the wake phrase on or off."),
  })
  .strict();

export const setWakePhraseTool: ToolDefinition = {
  name: "voice.setWakePhrase",
  capability: "settings",
  operation: "updateVoice",
  description:
    '"Cambiá tu wake phrase a Liz", "activá la palabra de activación": changes ELISE\'s wake phrase among the supported ones (Elise, Hey Elise, Oye Elise, Liz) or turns it on/off. Any other phrase isn\'t supported — say so.',
  input: wakeInput,
  async describe(raw) {
    const q = wakeInput.parse(raw);
    return {
      summary: [
        q.phrase && `Wake phrase → ${WAKE_LABELS[q.phrase]}`,
        q.enabled !== undefined && `Wake phrase ${q.enabled ? "on" : "off"}`,
      ]
        .filter(Boolean)
        .join(", "),
    };
  },
  async run(raw, env) {
    const q = wakeInput.parse(raw);
    if (!q.phrase && q.enabled === undefined)
      throw new AppError("VALIDATION_ERROR", "Nothing to change", { recovery: "review" });
    const before = await store(env).voice();
    const after = await store(env).updateVoice({
      ...(q.phrase ? { wakePhrase: q.phrase } : {}),
      ...(q.enabled !== undefined ? { wakeEnabled: q.enabled } : {}),
    });
    const device = env.ctx.voiceWake ?? null;
    const works = device === "ready" || device === "listening";
    return {
      output: {
        updated: true,
        wakePhrase: WAKE_LABELS[after.wakePhrase],
        enabled: after.wakeEnabled,
        onThisDevice: device ?? "unknown",
        instructions: after.wakeEnabled
          ? works
            ? "Saved. Say it works while a voice session sleeps on this device, with the page open."
            : device === "downloadable"
              ? "Saved, but this browser first needs its on-device speech pack: the user can install it in Settings › Voice. Don't say it works yet."
              : "Saved, but this browser can't detect a wake phrase on the device (it needs Chrome with on-device speech). Say so plainly — tapping the microphone still works."
          : "Saved.",
      },
      display: {
        kind: "setting_changed",
        changes: [
          ...(q.phrase
            ? [
                {
                  setting: "wake_phrase" as const,
                  from: WAKE_LABELS[before.wakePhrase],
                  to: WAKE_LABELS[after.wakePhrase],
                },
              ]
            : []),
          ...(q.enabled !== undefined
            ? [
                {
                  setting: "wake_phrase" as const,
                  from: before.wakeEnabled ? "on" : "off",
                  to: after.wakeEnabled ? "on" : "off",
                  subject: "enabled",
                },
              ]
            : []),
        ],
      },
    };
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
  setWakePhraseTool,
  listModulesTool,
  enableModulesTool,
  disableModulesTool,
];

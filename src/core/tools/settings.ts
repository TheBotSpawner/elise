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
    const p = await store(env).update({
      ...(u.language ? { language: u.language } : {}),
      ...(u.timezone ? { timezone: resolveTimezone(u.timezone) } : {}),
    });
    return { output: { updated: true, language: p.language, timezone: p.timezone } };
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
  async describe(raw) {
    return { summary: `Theme → ${themeInput.parse(raw).theme}` };
  },
  async run(raw, env) {
    const p = await store(env).update({ theme: themeInput.parse(raw).theme });
    return {
      output: { theme: p.theme },
      display: { kind: "appearance", theme: p.theme, accent: p.accent },
    };
  },
};

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
  async describe(raw) {
    return { summary: `Accent → ${accentInput.parse(raw).accent}` };
  },
  async run(raw, env) {
    const p = await store(env).update({ accent: accentInput.parse(raw).accent });
    return {
      output: { accent: p.accent },
      display: { kind: "appearance", theme: p.theme, accent: p.accent },
    };
  },
};

const scheduleForModel = (s: ScheduleSummary) => ({
  schedule: s.id,
  name: s.name,
  status: s.status,
  notifications: s.notify,
  ...(s.nextRunAt ? { nextRunAt: s.nextRunAt } : {}),
});

export const getNotificationsTool: ToolDefinition = {
  name: "notifications.getPreferences",
  capability: "settings",
  operation: "getNotifications",
  description:
    "How each Schedule (e.g. the Morning Brief) notifies the user: none, in ELISE, or browser notification.",
  input: z.object({}).strict(),
  async describe() {
    return { summary: "Read notification preferences" };
  },
  async run(_raw, env) {
    return { output: { schedules: (await store(env).schedules()).map(scheduleForModel) } };
  },
};

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

const notifyInput = z
  .object({
    browser: z
      .boolean()
      .optional()
      .describe("false: no browser notifications from any schedule (they stay in ELISE)."),
    schedule: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .optional()
      .describe("One schedule by name, e.g. Morning Brief."),
    notify: z.enum(["none", "in_app", "browser"]).optional(),
  })
  .strict();

export const updateNotificationsTool: ToolDefinition = {
  name: "notifications.updatePreferences",
  capability: "settings",
  operation: "updateNotifications",
  description:
    '"Turn off browser notifications" → {browser:false}. "Keep Morning Brief notifications" → {schedule:"Morning Brief", notify:"in_app"}. Uses the existing per-schedule notification settings.',
  input: notifyInput,
  async describe(raw) {
    const u = notifyInput.parse(raw);
    return {
      summary: u.schedule
        ? `${u.schedule} notifications → ${u.notify ?? "in_app"}`
        : `Browser notifications ${u.browser ? "on" : "off"}`,
    };
  },
  async run(raw, env) {
    const u = notifyInput.parse(raw);
    const s = store(env);
    if (u.schedule) {
      if (!u.notify)
        throw new AppError("VALIDATION_ERROR", "Say how it should notify", { recovery: "review" });
      const target = await pickSchedule(env, u.schedule);
      await s.setScheduleNotify(target.id, u.notify);
    } else if (u.browser !== undefined) {
      for (const sc of await s.schedules()) {
        if (!u.browser && sc.notify === "browser") await s.setScheduleNotify(sc.id, "in_app");
        if (u.browser && sc.notify === "in_app") await s.setScheduleNotify(sc.id, "browser");
      }
    } else {
      throw new AppError("VALIDATION_ERROR", "Nothing to change", { recovery: "review" });
    }
    return { output: { updated: true, schedules: (await s.schedules()).map(scheduleForModel) } };
  },
};

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

export const SETTINGS_TOOLS = [
  getSettingsTool,
  updateSettingsTool,
  getAppearanceTool,
  setThemeTool,
  setAccentTool,
  getNotificationsTool,
  updateNotificationsTool,
  listSchedulesTool,
  pauseTool("pause"),
  pauseTool("resume"),
  listConnectionsTool,
];

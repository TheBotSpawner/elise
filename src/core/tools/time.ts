import { z } from "zod";

import type { ToolDefinition, ToolRunEnv } from "../agents/tools";
import { resolveTimezone } from "../capabilities/settings";
import { AppError } from "../errors";
import {
  addTime,
  AUTO_START,
  cancel,
  clockText,
  currentPhase,
  elapsedMs,
  isActive,
  lap,
  pause,
  phaseLabel,
  remainingMs,
  reset,
  resolveTimer,
  resume,
  skipPhase,
  spokenDuration,
  TIME_LIMITS,
  TIMER_KINDS,
  type Timer,
  type TimerPatch,
  type TimerStore,
} from "../timers/model";
import { timerSnapshot } from "../workspace/time";

/**
 * Native Time through conversation (ADR-045): five small tools over the user's own timers.
 * Every answer about time left comes from the stored timestamps — never the model's estimate.
 * Timer changes are low-risk writes: automatic, recorded and audited like any other.
 */

const store = (env: ToolRunEnv): TimerStore => env.providers.get("time", env.binding);
const es = (env: ToolRunEnv) => env.ctx.locale === "es";
const MIN = 60_000;

const timerRef = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .optional()
  .describe(
    'Which one, by its label ("pasta", "lavarropas") or id. Omit when the user didn\'t say: the only active timer is used.',
  );

/** Timers on the user's screen right now (they disambiguate "pausalo"). */
function onScreen(env: ToolRunEnv): string[] {
  return (env.ctx.workspace?.state().surfaces ?? [])
    .filter((s) => s.type === "timer")
    .map((s) => (s.payload as { id?: string }).id ?? "")
    .filter(Boolean);
}

/** What the model may say about a timer: computed, in words, ready to speak. */
function describe(t: Timer, env: ToolRunEnv) {
  const now = env.ctx.now;
  const locale = env.ctx.locale;
  const phase = currentPhase(t);
  const left = remainingMs(t, now);
  return {
    id: t.id,
    kind: t.kind,
    label: t.label,
    state: t.state,
    ...(t.kind === "stopwatch"
      ? { elapsed: clockText(elapsedMs(t, now), false), laps: t.laps.length }
      : {
          remaining: clockText(left),
          remainingSpoken: spokenDuration(left, locale),
          endsAt: t.endsAt,
        }),
    ...(phase && t.pomodoro
      ? { phase: phaseLabel(phase.phase, locale), cycle: `${phase.cycle}/${t.pomodoro.cycles}` }
      : {}),
  };
}

function show(t: Timer, env: ToolRunEnv, extra: Record<string, unknown> = {}) {
  return {
    output: { ...extra, timer: describe(t, env) },
    display: { kind: "timer" as const, timer: timerSnapshot(t, env.ctx.now) },
    target: { type: "timer", id: t.id },
  };
}

// ── time.start ───────────────────────────────────────────────────────────────

const startInput = z
  .object({
    kind: z.enum(TIMER_KINDS).default("timer"),
    minutes: z
      .number()
      .min(0)
      .max(24 * 60)
      .optional()
      .describe('"media hora" → 30.'),
    seconds: z.number().min(0).max(3_600).optional(),
    label: z
      .string()
      .trim()
      .min(1)
      .max(TIME_LIMITS.maxLabel)
      .optional()
      .describe(
        'What it\'s for, short ("Pasta", "Legislación"). Inside a Knowledge Section and studying → the Section\'s name.',
      ),
    focusMinutes: z.number().min(1).max(180).optional().describe('Pomodoro: "de 50 y 10" → 50.'),
    breakMinutes: z.number().min(1).max(60).optional().describe('Pomodoro: "de 50 y 10" → 10.'),
    longBreakMinutes: z.number().min(0).max(90).optional(),
    cycles: z.number().int().min(1).max(12).optional(),
    autoStart: z.enum(AUTO_START).optional(),
  })
  .strict();

export const startTimeTool: ToolDefinition = {
  name: "time.start",
  capability: "time",
  operation: "start",
  description:
    '"Poneme 20 minutos", "timer de media hora para la pasta", "avisame en 10 minutos" → kind timer. "Arranquemos un pomodoro", "pomodoro de 50 y 10" → kind pomodoro. "Arrancá un cronómetro" → kind stopwatch. Several can run at once.',
  input: startInput,
  async describe(raw, env) {
    const s = startInput.parse(raw);
    return { summary: es(env) ? `Iniciar ${s.label ?? s.kind}` : `Start ${s.label ?? s.kind}` };
  },
  async run(raw, env) {
    const s = startInput.parse(raw);
    const st = store(env);
    const active = (await st.list()).filter(isActive);
    if (active.length >= TIME_LIMITS.maxActive)
      throw new AppError("VALIDATION_ERROR", "That's a lot of timers at once: cancel one first.", {
        recovery: "review",
      });
    const durationMs = Math.round(((s.minutes ?? 0) * 60 + (s.seconds ?? 0)) * 1000);
    if (s.kind === "timer" && durationMs <= 0)
      throw new AppError("VALIDATION_ERROR", "How long? Ask for the duration.", {
        recovery: "review",
      });
    const prefs = s.kind === "pomodoro" ? (await st.preferences()).pomodoro : null;
    const pomodoro = prefs
      ? {
          focusMs: s.focusMinutes ? s.focusMinutes * MIN : prefs.focusMs,
          shortBreakMs: s.breakMinutes ? s.breakMinutes * MIN : prefs.shortBreakMs,
          longBreakMs:
            s.longBreakMinutes !== undefined ? s.longBreakMinutes * MIN : prefs.longBreakMs,
          cycles: s.cycles ?? prefs.cycles,
          autoStart: s.autoStart ?? prefs.autoStart,
        }
      : undefined;
    // Studying inside a Section: its name labels the Pomodoro (labeling only, never access).
    const label =
      s.label ?? (s.kind === "pomodoro" && env.ctx.context ? env.ctx.context.name : null);
    const t = await st.create({
      kind: s.kind,
      label: label?.slice(0, TIME_LIMITS.maxLabel) ?? null,
      durationMs,
      ...(pomodoro ? { pomodoro } : {}),
      provenance: {
        conversationId: env.ctx.conversationId ?? null,
        sessionId: env.ctx.interactionSessionId ?? null,
        spaceId: env.ctx.knowledgeSpaceId ?? null,
      },
    });
    const say =
      s.kind === "stopwatch"
        ? es(env)
          ? "Listo, cronómetro en marcha."
          : "Stopwatch running."
        : s.kind === "pomodoro"
          ? es(env)
            ? `Dale. ${spokenDuration(t.durationMs, "es")} de foco.`
            : `On it. ${spokenDuration(t.durationMs, "en")} of focus.`
          : es(env)
            ? `Dale. ${spokenDuration(t.durationMs, "es")}.`
            : `Sure. ${spokenDuration(t.durationMs, "en")}.`;
    return show(t, env, {
      started: true,
      say,
      instructions: "Answer with `say` only. The timer is on screen and keeps running everywhere.",
    });
  },
};

// ── time.list ────────────────────────────────────────────────────────────────

const listInput = z.object({ timer: timerRef }).strict();

export const listTimeTool: ToolDefinition = {
  name: "time.list",
  capability: "time",
  operation: "list",
  description:
    '"¿Cuánto falta?", "mostrame mis timers", "¿cuánto llevo?": the user\'s timers with exactly what\'s left (computed, never estimated). Answer with remainingSpoken.',
  input: listInput,
  async describe() {
    return { summary: "Timers" };
  },
  async run(raw, env) {
    const { timer } = listInput.parse(raw);
    const all = await store(env).list({ includeFinished: Boolean(timer) });
    if (timer) return show(resolveTimer(all, timer, { onScreen: onScreen(env) }), env);
    const active = all.filter(isActive);
    return {
      output: active.length
        ? { timers: active.map((t) => describe(t, env)) }
        : { timers: [], none: true },
      display: {
        kind: "timers" as const,
        timers: active.slice(0, 4).map((t) => timerSnapshot(t, env.ctx.now)),
      },
    };
  },
};

// ── time.control ─────────────────────────────────────────────────────────────

const ACTIONS = ["pause", "resume", "cancel", "reset", "lap", "skip"] as const;

const controlInput = z
  .object({
    action: z
      .enum(ACTIONS)
      .describe(
        '"Pausalo" → pause; "seguí"/"seguimos" → resume; "cancelá el timer" / "pará el pomodoro" → cancel; "reinicialo" / "reseteá el cronómetro" → reset; "vuelta" → lap; "saltá el descanso" → skip.',
      ),
    timer: timerRef,
  })
  .strict();

const ACK: Record<(typeof ACTIONS)[number], { es: string; en: string }> = {
  pause: { es: "Pausado.", en: "Paused." },
  resume: { es: "Sigue.", en: "Running again." },
  cancel: { es: "Cancelado.", en: "Cancelled." },
  reset: { es: "Reiniciado.", en: "Restarted." },
  lap: { es: "Vuelta.", en: "Lap." },
  skip: { es: "Listo, siguiente fase.", en: "On to the next phase." },
};

export const controlTimeTool: ToolDefinition = {
  name: "time.control",
  capability: "time",
  operation: "control",
  description:
    "Pause, resume, cancel, restart, lap or skip a phase of a timer, Pomodoro or stopwatch.",
  input: controlInput,
  async describe(raw, env) {
    const c = controlInput.parse(raw);
    return { summary: `${ACK[c.action][es(env) ? "es" : "en"]} ${c.timer ?? ""}`.trim() };
  },
  async run(raw, env) {
    const c = controlInput.parse(raw);
    const st = store(env);
    const all = await st.list({ includeFinished: true });
    const t = resolveTimer(
      // Without a name, only timers this action can apply to.
      c.timer ? all : all.filter((x) => (c.action === "lap" ? x.kind === "stopwatch" : true)),
      c.timer,
      { onScreen: onScreen(env) },
    );
    const now = env.ctx.now;
    const patch: TimerPatch =
      c.action === "pause"
        ? pause(t, now)
        : c.action === "resume"
          ? resume(t, now)
          : c.action === "cancel"
            ? cancel(t)
            : c.action === "reset"
              ? reset(t, now)
              : c.action === "lap"
                ? lap(t, now)
                : skipPhase(t, now);
    const next = Object.keys(patch).length ? await st.change(t, patch, `timer.${c.action}`) : t;
    return show(next, env, { say: ACK[c.action][es(env) ? "es" : "en"] });
  },
};

// ── time.addTime ─────────────────────────────────────────────────────────────

const addInput = z
  .object({
    minutes: z
      .number()
      .min(-24 * 60)
      .max(24 * 60)
      .describe('"Sumale cinco" → 5; "restale dos" → -2.'),
    seconds: z.number().min(-3_600).max(3_600).optional(),
    timer: timerRef,
  })
  .strict();

export const addTimeTool: ToolDefinition = {
  name: "time.addTime",
  capability: "time",
  operation: "addTime",
  description: '"Sumale cinco minutos", "restale dos", "sumale 10 al lavarropas".',
  input: addInput,
  async describe(raw) {
    const a = addInput.parse(raw);
    return { summary: `${a.minutes > 0 ? "+" : ""}${a.minutes} min` };
  },
  async run(raw, env) {
    const a = addInput.parse(raw);
    const delta = Math.round((a.minutes * 60 + (a.seconds ?? 0)) * 1000);
    if (!delta)
      throw new AppError("VALIDATION_ERROR", "How much time? Ask.", { recovery: "review" });
    const st = store(env);
    const all = await st.list({ includeFinished: true });
    const t = resolveTimer(a.timer ? all : all.filter((x) => x.kind !== "stopwatch"), a.timer, {
      onScreen: onScreen(env),
    });
    const next = await st.change(t, addTime(t, delta, env.ctx.now), "timer.add_time");
    const left = spokenDuration(remainingMs(next, env.ctx.now), env.ctx.locale);
    return show(next, env, {
      say: es(env) ? `Listo. Quedan ${left}.` : `Done. ${left} left.`,
    });
  },
};

// ── time.now ─────────────────────────────────────────────────────────────────

const nowInput = z
  .object({
    place: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .optional()
      .describe('A city or time zone ("Auckland", "Europe/Madrid"); omit for the user\'s own.'),
    show: z
      .boolean()
      .default(false)
      .describe(
        '"Mostrame un reloj", "poneme el reloj en pantalla" → true. A plain "¿qué hora es?" → false.',
      ),
  })
  .strict();

export const nowTimeTool: ToolDefinition = {
  name: "time.now",
  capability: "time",
  operation: "now",
  description:
    '"¿Qué hora es?", "¿qué hora es en Auckland?", "mostrame un reloj": the exact current time (never guess it).',
  input: nowInput,
  async describe() {
    return { summary: "Time" };
  },
  async run(raw, env) {
    const n = nowInput.parse(raw);
    const timezone = n.place ? resolveTimezone(n.place) : env.ctx.timezone;
    const hour12 = env.ctx.locale === "en";
    const locale = env.ctx.locale === "es" ? "es-AR" : "en-US";
    const fmt = (o: Intl.DateTimeFormatOptions) =>
      new Intl.DateTimeFormat(locale, { timeZone: timezone, ...o }).format(env.ctx.now);
    return {
      output: {
        time: fmt({ hour: "numeric", minute: "2-digit", hour12 }),
        date: fmt({ weekday: "long", day: "numeric", month: "long" }),
        timezone,
      },
      ...(n.show
        ? {
            display: {
              kind: "clock" as const,
              clock: { timezone, place: n.place ?? null, hour12 },
            },
          }
        : {}),
    };
  },
};

export const TIME_TOOLS = [startTimeTool, listTimeTool, controlTimeTool, addTimeTool, nowTimeTool];

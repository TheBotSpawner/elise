import { z } from "zod";

import type { ToolDefinition, ToolRunEnv } from "../agents/tools";
import { AppError } from "../errors";
import { addDays, toLocalDateTime, todayIn } from "../time";
import {
  defaultDestinations,
  ALARM_LIMITS,
  ALARM_SOUNDS,
  deliveryCheck,
  isBundledSound,
  isTime,
  type Alarm,
  type AlarmDestination,
  type AlarmStore,
  type DestinationStatus,
  type SoundOption,
} from "../timers/alarms";
import type { TimePreferences } from "../timers/model";
import type { SurfacePayloads } from "../workspace/registry";

/**
 * Alarms through conversation (ADR-100). The model says what the user asked; ELISE resolves the
 * day, the time, the sound and where it rings — and says honestly when nothing can ring it.
 * Changes are low-risk writes (automatic, audited), like timers.
 */

type Store = AlarmStore & { preferences(): Promise<TimePreferences> };
const store = (env: ToolRunEnv): Store => env.providers.get("time", env.binding);

const WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;
const WEEKDAYS_ES = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];

const time = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
  .describe(
    'Local 24-hour "HH:mm". "a las 7" for waking up → 07:00; "a las 7 de la tarde" → 19:00.',
  );
const day = z
  .enum(["today", "tomorrow"])
  .optional()
  .describe("hoy → today, mañana → tomorrow. Omit: the next time that hour comes.");
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .optional()
  .describe("A specific day instead of `day` (a weekday the user named, once).");
const weekdays = z
  .array(z.enum(WEEKDAYS))
  .max(7)
  .optional()
  .describe(
    'Repeating: "todos los lunes y miércoles" → ["monday","wednesday"]; "todos los días" → all seven.',
  );
const destinations = z
  .array(z.string().trim().min(1).max(80))
  .max(10)
  .optional()
  .describe(
    'Where it rings, as the user said it: "browser" (navegador), "desktop" (PC / ELISE Desktop), "all", or a device\'s name. Omit to use their default.',
  );
const alarmRef = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .optional()
  .describe(
    'Which alarm: its id, label ("facultad") or time ("07:00"). Omit when there is only one, or for the one on screen.',
  );

const label = (a: Pick<Alarm, "label" | "time">) => a.label ?? a.time;

/**
 * Does it ring on this local day — including earlier today, when it already rang and a one-off
 * is now off (its next ring is gone, the day's answer isn't)?
 */
function ringsOn(a: Alarm, day: string, tz: string): boolean {
  if (a.nextFireAt && toLocalDateTime(new Date(a.nextFireAt), tz).slice(0, 10) === day) return true;
  if (a.date) return a.date === day;
  return a.enabled && a.weekdays.includes(new Date(`${day}T12:00:00Z`).getUTCDay());
}
const fold = (s: string) => s.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").trim();

/** The day a one-off alarm rings: the one asked, else the next time that hour comes. */
function resolveDay(env: ToolRunEnv, q: { day?: string; date?: string; time: string }) {
  const tz = env.ctx.timezone;
  const today = todayIn(tz, env.ctx.now);
  if (q.date) return q.date;
  if (q.day === "today") return today;
  if (q.day === "tomorrow") return addDays(today, 1);
  const nowLocal = toLocalDateTime(env.ctx.now, tz).slice(11, 16);
  return q.time > nowLocal ? today : addDays(today, 1);
}

/** "browser", "desktop", "all" or a device name → the user's registered destinations. */
function resolveDestinations(
  asked: string[] | undefined,
  known: DestinationStatus[],
  defaults: AlarmDestination[],
) {
  if (!asked?.length) return { chosen: defaultDestinations(defaults, known), missing: [] };
  const chosen: AlarmDestination[] = [];
  const missing: string[] = [];
  for (const raw of asked) {
    const a = fold(raw);
    const kind =
      a === "all" || a === "todos" || a === "todas"
        ? "all"
        : /navegador|browser|chrome|edge|firefox|safari|web/.test(a)
          ? "browser"
          : /desktop|pc|compu|computadora|escritorio|notebook|laptop/.test(a)
            ? "desktop"
            : null;
    const matches =
      kind === "all"
        ? known
        : kind
          ? known.filter((k) => k.kind === kind)
          : known.filter((k) => fold(k.name).includes(a));
    if (!matches.length) missing.push(raw);
    for (const m of matches)
      if (!chosen.some((c) => c.kind === m.kind && c.id === m.id))
        chosen.push({ kind: m.kind, id: m.id });
  }
  return { chosen, missing };
}

function resolveSound(asked: string | undefined, sounds: SoundOption[]): string | null {
  if (!asked) return null;
  const a = fold(asked);
  const found =
    sounds.find((s) => fold(s.key) === a || fold(s.name) === a) ??
    sounds.find((s) => fold(s.name).includes(a));
  if (!found)
    throw new AppError(
      "VALIDATION_ERROR",
      `No sound called "${asked}". Available: ${sounds.map((s) => s.name).join(", ")}.`,
      {
        recovery: "review",
      },
    );
  return found.key;
}

/** Deterministic: an id, a label, a time; else the only alarm; else the one on screen. */
function pick(alarms: Alarm[], ref: string | undefined, env: ToolRunEnv): Alarm {
  if (ref) {
    const r = fold(ref);
    const exact = alarms.filter((a) => a.id === ref || fold(a.label ?? "") === r || a.time === ref);
    const partial = exact.length
      ? exact
      : alarms.filter((a) => a.label && fold(a.label).includes(r));
    if (partial.length === 1) return partial[0]!;
    if (partial.length > 1)
      throw new AppError(
        "VALIDATION_ERROR",
        `Several alarms match: ${partial.map((a) => `${label(a)} (${a.id})`).join(", ")}. Ask which one.`,
        { recovery: "review" },
      );
    throw new AppError("NOT_FOUND", `No alarm matches "${ref}".`, { recovery: "review" });
  }
  if (alarms.length === 1) return alarms[0]!;
  const shown = (env.ctx.workspace?.state().surfaces ?? [])
    .filter((s) => s.type === "alarms")
    .flatMap((s) => (s.payload as SurfacePayloads["alarms"]).alarms.map((a) => a.id));
  const onScreen = alarms.filter((a) => shown.includes(a.id));
  if (onScreen.length === 1) return onScreen[0]!;
  throw new AppError("VALIDATION_ERROR", "Which alarm? Several exist: give its label or time.", {
    recovery: "review",
  });
}

function view(a: Alarm, known: DestinationStatus[], sounds: SoundOption[], prefs: TimePreferences) {
  const key = a.sound ?? prefs.alarmSound;
  return {
    id: a.id,
    label: a.label,
    time: a.time,
    date: a.date,
    weekdays: a.weekdays,
    enabled: a.enabled,
    state: a.state,
    nextFireAt: a.nextFireAt,
    sound: a.sound,
    soundName:
      sounds.find((s) => s.key === key)?.name ??
      (isBundledSound(key) ? ALARM_SOUNDS[key].name : key),
    snoozeMinutes: a.snoozeMinutes,
    destinations: a.destinations.map((d) => {
      const k = known.find((x) => x.kind === d.kind && x.id === d.id);
      return { kind: d.kind, id: d.id, name: k?.name ?? null, online: k?.online ?? false };
    }),
  };
}

/** What the model may say about an alarm: computed words, honest about where it can ring. */
function forModel(a: Alarm, env: ToolRunEnv, known: DestinationStatus[]) {
  const when = a.nextFireAt ? toLocalDateTime(new Date(a.nextFireAt), a.timezone) : null;
  const d = deliveryCheck(a.destinations, known);
  return {
    alarm: a.id,
    label: a.label,
    time: a.time,
    ...(a.weekdays.length
      ? { repeats: a.weekdays.map((w) => (env.ctx.locale === "es" ? WEEKDAYS_ES[w] : WEEKDAYS[w])) }
      : { date: a.date }),
    nextRing: when,
    timezone: a.timezone,
    enabled: a.enabled,
    state: a.state,
    ringsOn: d.ready.map((x) => x.name),
    ...(d.offline.length ? { offlineNow: d.offline.map((x) => x.name) } : {}),
    ...(!a.destinations.length
      ? {
          noDestination:
            "It has no device to ring on yet: say so and that it's chosen in Mi ELISE → Tiempos.",
        }
      : {}),
  };
}

async function surface(
  env: ToolRunEnv,
  alarms: Alarm[],
  extra: Partial<SurfacePayloads["alarms"]> = {},
) {
  const s = store(env);
  const [known, sounds, prefs] = await Promise.all([s.destinations(), s.sounds(), s.preferences()]);
  const payload: SurfacePayloads["alarms"] = {
    alarms: alarms.slice(0, 12).map((a) => view(a, known, sounds, prefs)),
    timezone: env.ctx.timezone,
    defaultSound: prefs.alarmSound,
    ...extra,
  };
  return { known, sounds, prefs, display: { kind: "alarms" as const, alarms: payload } };
}

const HONEST =
  "Say the day and time in words. If ringsOn is empty, say clearly that no device can ring it right now and how to choose one; never claim it will sound where it can't.";

// ── Tools ────────────────────────────────────────────────────────────────────

const setInput = z
  .object({
    time,
    day,
    date,
    weekdays,
    label: z.string().trim().min(1).max(80).optional(),
    sound: z.string().trim().max(60).optional().describe("A sound's name, if the user named one."),
    snoozeMinutes: z
      .number()
      .int()
      .min(ALARM_LIMITS.minSnooze)
      .max(ALARM_LIMITS.maxSnooze)
      .optional(),
    destinations,
  })
  .strict();

export const setAlarmTool: ToolDefinition = {
  name: "time.setAlarm",
  capability: "time",
  operation: "setAlarm",
  description:
    '"Poné una alarma mañana a las 7 para ir a la facultad", "despertame todos los lunes y miércoles a las 6:45", "que suene en mi PC": an alarm at a fixed time — not a timer (a duration). ELISE resolves the day and says where it can ring.',
  input: setInput,
  async describe(raw) {
    const q = setInput.parse(raw);
    return { summary: `Set an alarm at ${q.time}` };
  },
  async run(raw, env) {
    const q = setInput.parse(raw);
    if (!isTime(q.time))
      throw new AppError("VALIDATION_ERROR", "Time must be HH:mm.", { recovery: "review" });
    const s = store(env);
    const [known, sounds, prefs] = await Promise.all([
      s.destinations(),
      s.sounds(),
      s.preferences(),
    ]);
    const repeat = q.weekdays?.length
      ? [...new Set(q.weekdays.map((w) => WEEKDAYS.indexOf(w)))]
      : [];
    const { chosen, missing } = resolveDestinations(q.destinations, known, prefs.alarmDestinations);
    const alarm = await s.createAlarm({
      label: q.label ?? null,
      time: q.time,
      date: repeat.length ? null : resolveDay(env, q),
      weekdays: repeat,
      timezone: env.ctx.timezone,
      sound: resolveSound(q.sound, sounds),
      snoozeMinutes: q.snoozeMinutes ?? ALARM_LIMITS.defaultSnooze,
      destinations: chosen,
      provenance: {
        conversationId: env.ctx.conversationId ?? null,
        sessionId: env.ctx.interactionSessionId ?? null,
      },
    });
    const shown = await surface(env, [alarm], { focus: alarm.id });
    return {
      output: {
        created: forModel(alarm, env, known),
        ...(missing.length
          ? { notRegistered: missing, note2: "These devices aren't set up for alarms: say so." }
          : {}),
        instructions: HONEST,
      },
      display: shown.display,
      target: { type: "alarm", id: alarm.id },
    };
  },
};

const listInput = z
  .object({
    day: z.enum(["today", "tomorrow"]).optional().describe("hoy / mañana; omit for all alarms."),
    date,
  })
  .strict();

export const listAlarmsTool: ToolDefinition = {
  name: "time.listAlarms",
  capability: "time",
  operation: "listAlarms",
  description:
    '"¿Qué alarmas tengo para hoy?", "¿cuál sigue?", "mis alarmas": the user\'s alarms, next first, with where each rings. Times come from ELISE, in the user\'s timezone.',
  input: listInput,
  async describe() {
    return { summary: "List alarms" };
  },
  async run(raw, env) {
    const q = listInput.parse(raw);
    const s = store(env);
    const all = await s.listAlarms();
    const tz = env.ctx.timezone;
    const today = todayIn(tz, env.ctx.now);
    const wanted =
      q.date ?? (q.day === "today" ? today : q.day === "tomorrow" ? addDays(today, 1) : null);
    const alarms = wanted ? all.filter((a) => ringsOn(a, wanted, tz)) : all;
    const nowLocal = toLocalDateTime(env.ctx.now, tz).slice(11, 16);
    // The whole set on screen (as in Tiempos): the day's answer is in the output.
    const shown = await surface(env, all);
    return {
      output: {
        ...(wanted ? { day: wanted } : {}),
        count: alarms.length,
        alarms: alarms.map((a) => ({
          ...forModel(a, env, shown.known),
          // One that already rang today still counts for "¿tengo alarmas hoy?".
          ...(wanted === today && a.time <= nowLocal ? { alreadyRang: true } : {}),
        })),
        instructions: alarms.length
          ? "Say them briefly (time, label, where it rings; say which already rang); they are on screen."
          : "There are none for that: say it positively in one line and offer to set one.",
      },
      display: shown.display,
    };
  },
};

const changeInput = z
  .object({
    alarm: alarmRef,
    time: time.optional(),
    day,
    date,
    weekdays,
    label: z.string().trim().min(1).max(80).optional(),
    enabled: z.boolean().optional().describe("false: turn it off (kept); true: turn it back on."),
    sound: z.string().trim().max(60).optional(),
    snoozeMinutes: z
      .number()
      .int()
      .min(ALARM_LIMITS.minSnooze)
      .max(ALARM_LIMITS.maxSnooze)
      .optional(),
    destinations,
  })
  .strict();

export const changeAlarmTool: ToolDefinition = {
  name: "time.changeAlarm",
  capability: "time",
  operation: "changeAlarm",
  description:
    '"Cambiá la alarma de mañana a las 7:30", "apagá la alarma de la facultad", "que esa suene también en el navegador", "ponele el sonido Campana": changes one alarm.',
  input: changeInput,
  async describe(raw) {
    const q = changeInput.parse(raw);
    return { summary: `Change alarm ${q.alarm ?? ""}`.trim() };
  },
  async run(raw, env) {
    const q = changeInput.parse(raw);
    const s = store(env);
    const [alarms, known, sounds] = await Promise.all([
      s.listAlarms(),
      s.destinations(),
      s.sounds(),
    ]);
    const a = pick(alarms, q.alarm, env);
    const t = q.time ?? a.time;
    const repeat = q.weekdays
      ? [...new Set(q.weekdays.map((w) => WEEKDAYS.indexOf(w)))]
      : undefined;
    const moving = q.day || q.date || q.time;
    const next = await s.changeAlarm(a, {
      ...(q.time ? { time: q.time } : {}),
      ...(repeat
        ? { weekdays: repeat, date: repeat.length ? null : resolveDay(env, { ...q, time: t }) }
        : {}),
      ...(!repeat && moving && !a.weekdays.length
        ? { date: resolveDay(env, { ...q, time: t }) }
        : {}),
      ...(q.label ? { label: q.label } : {}),
      ...(q.enabled !== undefined ? { enabled: q.enabled } : {}),
      ...(q.sound ? { sound: resolveSound(q.sound, sounds) } : {}),
      ...(q.snoozeMinutes ? { snoozeMinutes: q.snoozeMinutes } : {}),
      ...(q.destinations
        ? { destinations: resolveDestinations(q.destinations, known, []).chosen }
        : {}),
    });
    const shown = await surface(env, [next], { focus: next.id });
    return {
      output: { changed: forModel(next, env, known), instructions: HONEST },
      display: shown.display,
      target: { type: "alarm", id: next.id },
    };
  },
};

const deleteInput = z.object({ alarm: alarmRef }).strict();

export const deleteAlarmTool: ToolDefinition = {
  name: "time.deleteAlarm",
  capability: "time",
  operation: "deleteAlarm",
  description:
    '"Borrá la alarma de las 7": deletes ONE alarm (to keep it but silence it, use time.changeAlarm enabled false).',
  input: deleteInput,
  async describe(raw) {
    return { summary: `Delete alarm ${deleteInput.parse(raw).alarm ?? ""}`.trim() };
  },
  async run(raw, env) {
    const q = deleteInput.parse(raw);
    const s = store(env);
    const alarms = await s.listAlarms();
    const a = pick(alarms, q.alarm, env);
    await s.deleteAlarm(a);
    const rest = alarms.filter((x) => x.id !== a.id);
    const shown = await surface(env, rest);
    return {
      output: { deleted: { label: a.label, time: a.time }, remaining: rest.length },
      display: shown.display,
      target: { type: "alarm", id: a.id },
    };
  },
};

const actionInput = z
  .object({
    action: z
      .enum(["snooze", "dismiss"])
      .describe("posponé / 5 minutos más → snooze; apagala / ya me levanté → dismiss."),
  })
  .strict();

export const alarmActionTool: ToolDefinition = {
  name: "time.alarmAction",
  capability: "time",
  operation: "alarmAction",
  description:
    '"Posponé la alarma", "apagá la alarma que está sonando": snooze or stop what is ringing now, on every device.',
  input: actionInput,
  async describe(raw) {
    return { summary: `${actionInput.parse(raw).action} alarm` };
  },
  async run(raw, env) {
    const q = actionInput.parse(raw);
    const s = store(env);
    const live = await s.liveOccurrences();
    const target = live.find((o) => (q.action === "snooze" ? o.status === "ringing" : true));
    if (!target)
      return {
        output: { nothingRinging: true, instructions: "No alarm is ringing: say so in one line." },
      };
    const done = await s.occurrenceAction(target.id, q.action);
    return {
      output: {
        action: q.action,
        label: done.label,
        ...(done.snoozedUntil
          ? { ringsAgainAt: toLocalDateTime(new Date(done.snoozedUntil), env.ctx.timezone) }
          : {}),
      },
    };
  },
};

const soundsInput = z
  .object({
    action: z.enum(["list", "setDefault"]),
    sound: z.string().trim().max(60).optional().describe("setDefault: the sound's name."),
  })
  .strict();

export const alarmSoundsTool: ToolDefinition = {
  name: "time.alarmSounds",
  capability: "time",
  operation: "alarmSounds",
  description:
    '"¿Qué sonidos de alarma tenés? Probame algunos" → list (each with a play button on screen; you can\'t play them yourself). "Poné Brisa como predeterminado" → setDefault.',
  input: soundsInput,
  async describe(raw) {
    return {
      summary: soundsInput.parse(raw).action === "list" ? "Alarm sounds" : "Set the alarm sound",
    };
  },
  async run(raw, env) {
    const q = soundsInput.parse(raw);
    const s = store(env);
    const sounds = await s.sounds();
    if (q.action === "setDefault") {
      const key = resolveSound(q.sound ?? "", sounds);
      if (!key) throw new AppError("VALIDATION_ERROR", "Say which sound.", { recovery: "review" });
      await s.setDefaultSound(key);
    }
    const prefs = await s.preferences();
    const shown = await surface(env, [], { sounds: sounds.slice(0, 20), focus: "sounds" });
    return {
      output: {
        sounds: sounds.map((x) => x.name),
        default: sounds.find((x) => x.key === prefs.alarmSound)?.name ?? prefs.alarmSound,
        instructions:
          q.action === "list"
            ? "They are on screen with a play button each: invite the user to try them. Never say you played one."
            : "Confirm the new default in one line.",
      },
      display: shown.display,
    };
  },
};

const destinationsInput = z
  .object({
    action: z.enum(["list", "setDefault"]),
    destinations: destinations.describe("setDefault: where new alarms ring."),
  })
  .strict();

export const alarmDestinationsTool: ToolDefinition = {
  name: "time.alarmDestinations",
  capability: "time",
  operation: "alarmDestinations",
  description:
    '"¿Dónde pueden sonar mis alarmas?", "que mis alarmas suenen en la PC por defecto": the devices set up for alarms (a browser the user chose, ELISE Desktop) and the default.',
  input: destinationsInput,
  async describe() {
    return { summary: "Alarm devices" };
  },
  async run(raw, env) {
    const q = destinationsInput.parse(raw);
    const s = store(env);
    const known = await s.destinations();
    if (q.action === "setDefault") {
      const { chosen, missing } = resolveDestinations(q.destinations, known, []);
      if (!chosen.length)
        throw new AppError(
          "VALIDATION_ERROR",
          `None of those devices is set up for alarms${missing.length ? `: ${missing.join(", ")}` : ""}.`,
          {
            recovery: "review",
          },
        );
      await s.setDefaultDestinations(chosen);
    }
    const prefs = await s.preferences();
    return {
      output: {
        devices: known.map((k) => ({ name: k.name, kind: k.kind, online: k.online })),
        defaults: prefs.alarmDestinations
          .map((d) => known.find((k) => k.kind === d.kind && k.id === d.id)?.name)
          .filter(Boolean),
        instructions: known.length
          ? "Say which devices exist and which are online. Mobile and Home Hub alarms aren't available yet."
          : 'No device is set up yet: a browser is added from Mi ELISE → Tiempos ("Usar este navegador"), a computer by installing ELISE Desktop.',
      },
    };
  },
};

export const ALARM_TOOLS = [
  setAlarmTool,
  listAlarmsTool,
  changeAlarmTool,
  deleteAlarmTool,
  alarmActionTool,
  alarmSoundsTool,
  alarmDestinationsTool,
];

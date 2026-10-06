import { AppError } from "../errors";

/**
 * Native Time (ADR-045): timers, Pomodoros and stopwatches are the user's own ELISE entities —
 * created from a conversation, owned by nobody's conversation. Pure and deterministic.
 *
 * Time is never counted down in storage. A running timer stores when it ends; what's left is
 * `endsAt − now`, correct after a reload, a closed tab or a sleeping laptop. Every change bumps
 * `version`, so a completion scheduled for an older version (paused, extended, cancelled since)
 * can never finish the timer.
 */

export const TIMER_KINDS = ["timer", "pomodoro", "stopwatch"] as const;
export type TimerKind = (typeof TIMER_KINDS)[number];

export const TIMER_STATES = ["running", "paused", "completed", "cancelled"] as const;
export type TimerState = (typeof TIMER_STATES)[number];

export const POMODORO_PHASES = ["focus", "short_break", "long_break"] as const;
export type PomodoroPhase = (typeof POMODORO_PHASES)[number];

/** Which next phase starts on its own: breaks only (default), every phase, or none. */
export const AUTO_START = ["breaks", "all", "none"] as const;
export type AutoStart = (typeof AUTO_START)[number];

export interface PomodoroConfig {
  focusMs: number;
  shortBreakMs: number;
  longBreakMs: number;
  cycles: number;
  autoStart: AutoStart;
}

export const SOUNDS = ["elise", "soft", "none"] as const;
export type TimerSound = (typeof SOUNDS)[number];

export interface TimePreferences {
  sound: TimerSound;
  /** A browser notification too (when the browser grants it), not only in ELISE. */
  notify: boolean;
  pomodoro: PomodoroConfig;
}

const MIN = 60_000;

export const DEFAULT_TIME_PREFERENCES: TimePreferences = {
  sound: "elise",
  notify: true,
  pomodoro: {
    focusMs: 25 * MIN,
    shortBreakMs: 5 * MIN,
    longBreakMs: 15 * MIN,
    cycles: 4,
    autoStart: "breaks",
  },
};

export const TIME_LIMITS = {
  maxDurationMs: 24 * 60 * MIN,
  maxActive: 20,
  maxLaps: 99,
  maxLabel: 80,
} as const;

/** Where a timer was created from: provenance only, never ownership. */
export interface TimerProvenance {
  conversationId?: string | null;
  sessionId?: string | null;
  scheduleId?: string | null;
  spaceId?: string | null;
}

export interface Timer {
  id: string;
  kind: TimerKind;
  label: string | null;
  state: TimerState;
  /** Timer/Pomodoro: the current run's full length (added time included). */
  durationMs: number;
  /** When the current running stretch began (a stopwatch's elapsed base). */
  startedAt: string | null;
  /** A running timer or Pomodoro phase ends here. */
  endsAt: string | null;
  /** A paused timer or phase: what was left. */
  remainingMs: number | null;
  /** Stopwatch: elapsed before the current running stretch. */
  elapsedMs: number;
  /** Stopwatch: total elapsed at each lap. */
  laps: number[];
  pomodoro: (PomodoroConfig & { phaseIndex: number }) | null;
  version: number;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  provenance: TimerProvenance;
}

/** What a change writes: only these fields move, and `version` always goes up by one. */
export type TimerPatch = Partial<
  Pick<
    Timer,
    | "state"
    | "durationMs"
    | "startedAt"
    | "endsAt"
    | "remainingMs"
    | "elapsedMs"
    | "laps"
    | "pomodoro"
    | "completedAt"
    | "label"
  >
>;

const iso = (ms: number) => new Date(ms).toISOString();
const t0 = (s: string | null) => (s ? Date.parse(s) : 0);

export const isActive = (t: Pick<Timer, "state">) => t.state === "running" || t.state === "paused";

// ── Reading time ─────────────────────────────────────────────────────────────

/** What's left of a timer or Pomodoro phase, from timestamps only. */
export function remainingMs(t: Timer, now: Date): number {
  if (t.kind === "stopwatch") return 0;
  if (t.state === "running") return Math.max(0, t0(t.endsAt) - now.getTime());
  if (t.state === "paused") return Math.max(0, t.remainingMs ?? 0);
  return 0;
}

/** A stopwatch's elapsed time. */
export function elapsedMs(t: Timer, now: Date): number {
  if (t.kind !== "stopwatch") return Math.max(0, t.durationMs - remainingMs(t, now));
  return t.state === "running"
    ? t.elapsedMs + Math.max(0, now.getTime() - t0(t.startedAt))
    : t.elapsedMs;
}

// ── Pomodoro ─────────────────────────────────────────────────────────────────

export interface PhaseStep {
  phase: PomodoroPhase;
  ms: number;
  /** 1-based focus block this phase belongs to. */
  cycle: number;
}

/** focus, break, focus, break… focus, then a long break (if any). Never endless. */
export function pomodoroPhases(c: PomodoroConfig): PhaseStep[] {
  const out: PhaseStep[] = [];
  for (let cycle = 1; cycle <= c.cycles; cycle++) {
    out.push({ phase: "focus", ms: c.focusMs, cycle });
    if (cycle < c.cycles) out.push({ phase: "short_break", ms: c.shortBreakMs, cycle });
    else if (c.longBreakMs > 0) out.push({ phase: "long_break", ms: c.longBreakMs, cycle });
  }
  return out;
}

export function currentPhase(t: Timer): PhaseStep | null {
  return t.pomodoro ? (pomodoroPhases(t.pomodoro)[t.pomodoro.phaseIndex] ?? null) : null;
}

const autoStarts = (auto: AutoStart, next: PomodoroPhase) =>
  auto === "all" || (auto === "breaks" && next !== "focus");

// ── Changes ──────────────────────────────────────────────────────────────────

export interface NewTimer {
  kind: TimerKind;
  label: string | null;
  durationMs: number;
  pomodoro?: PomodoroConfig;
  provenance: TimerProvenance;
}

/** The first state of a new timer, Pomodoro or stopwatch: running from `now`. */
export function startState(n: NewTimer, now: Date): TimerPatch {
  const at = now.getTime();
  if (n.kind === "stopwatch")
    return { state: "running", startedAt: iso(at), elapsedMs: 0, laps: [], durationMs: 0 };
  const ms = n.kind === "pomodoro" ? n.pomodoro!.focusMs : n.durationMs;
  if (!(ms > 0) || ms > TIME_LIMITS.maxDurationMs)
    throw new AppError("VALIDATION_ERROR", "A timer runs between 1 second and 24 hours.", {
      recovery: "review",
    });
  return {
    state: "running",
    durationMs: ms,
    startedAt: iso(at),
    endsAt: iso(at + ms),
    remainingMs: null,
    ...(n.kind === "pomodoro" ? { pomodoro: { ...n.pomodoro!, phaseIndex: 0 } } : {}),
  };
}

const done = (what: string) =>
  new AppError("VALIDATION_ERROR", `That ${what} already finished.`, { recovery: "review" });

export function pause(t: Timer, now: Date): TimerPatch {
  if (t.state === "paused") return {};
  if (t.state !== "running") throw done(t.kind);
  if (t.kind === "stopwatch")
    return { state: "paused", elapsedMs: elapsedMs(t, now), startedAt: null };
  return { state: "paused", remainingMs: remainingMs(t, now), endsAt: null };
}

export function resume(t: Timer, now: Date): TimerPatch {
  if (t.state === "running") return {};
  if (t.state !== "paused") throw done(t.kind);
  const at = now.getTime();
  if (t.kind === "stopwatch") return { state: "running", startedAt: iso(at) };
  return {
    state: "running",
    startedAt: iso(at),
    endsAt: iso(at + (t.remainingMs ?? 0)),
    remainingMs: null,
  };
}

export function cancel(t: Timer): TimerPatch {
  if (t.state === "cancelled") return {};
  return { state: "cancelled", endsAt: null };
}

/**
 * "Sumale cinco" / "restale dos". Running or paused: moves the end. Taking off more than is
 * left ends it now. A finished timer restarts with what was added.
 */
export function addTime(t: Timer, deltaMs: number, now: Date): TimerPatch {
  if (t.kind === "stopwatch")
    throw new AppError("VALIDATION_ERROR", "A stopwatch counts up: there's no time to add.", {
      recovery: "review",
    });
  const at = now.getTime();
  if (!isActive(t)) {
    if (deltaMs <= 0) throw done(t.kind);
    return {
      state: "running",
      durationMs: deltaMs,
      startedAt: iso(at),
      endsAt: iso(at + deltaMs),
      remainingMs: null,
      completedAt: null,
    };
  }
  const left = remainingMs(t, now) + deltaMs;
  if (left > TIME_LIMITS.maxDurationMs)
    throw new AppError("VALIDATION_ERROR", "A timer runs at most 24 hours.", {
      recovery: "review",
    });
  const durationMs = Math.max(0, t.durationMs + deltaMs);
  if (left <= 0)
    return {
      state: "completed",
      durationMs,
      endsAt: iso(at),
      remainingMs: null,
      completedAt: iso(at),
    };
  return t.state === "running"
    ? { durationMs, endsAt: iso(at + left) }
    : { durationMs, remainingMs: left };
}

/** Timer: starts again from its full length. Stopwatch: back to zero, laps cleared. */
export function reset(t: Timer, now: Date): TimerPatch {
  const at = now.getTime();
  if (t.kind === "stopwatch")
    return {
      elapsedMs: 0,
      laps: [],
      startedAt: t.state === "running" ? iso(at) : null,
      state: t.state === "running" ? "running" : "paused",
    };
  const ms = t.kind === "pomodoro" ? (currentPhase(t)?.ms ?? t.durationMs) : t.durationMs;
  return {
    state: "running",
    durationMs: ms,
    startedAt: iso(at),
    endsAt: iso(at + ms),
    remainingMs: null,
    completedAt: null,
  };
}

export function lap(t: Timer, now: Date): TimerPatch {
  if (t.kind !== "stopwatch")
    throw new AppError("VALIDATION_ERROR", "Only a stopwatch takes laps.", { recovery: "review" });
  if (t.laps.length >= TIME_LIMITS.maxLaps)
    throw new AppError("VALIDATION_ERROR", "That's the most laps a stopwatch keeps.", {
      recovery: "review",
    });
  return { laps: [...t.laps, elapsedMs(t, now)] };
}

/** What happened when a timer reached its end (one notification, whatever was missed). */
export interface Completion {
  kind: "timer_done" | "phase_done" | "pomodoro_done";
  /** Pomodoro: the phase now on (running or waiting to start). */
  next?: PhaseStep;
  /** Pomodoro: whether the next phase started on its own. */
  started?: boolean;
  /** When the end really was (not when it was noticed). */
  at: string;
}

/**
 * Brings a timer up to `now`: a running timer past its end completes (at its end time, not
 * when it was noticed); a Pomodoro moves through every phase that ended meanwhile.
 * Idempotent: settling a settled timer changes nothing.
 */
export function settle(t: Timer, now: Date): { patch: TimerPatch; completion: Completion | null } {
  if (t.kind === "stopwatch" || t.state !== "running" || t0(t.endsAt) > now.getTime())
    return { patch: {}, completion: null };
  if (t.kind === "timer" || !t.pomodoro) {
    return {
      patch: { state: "completed", completedAt: t.endsAt, endsAt: t.endsAt },
      completion: { kind: "timer_done", at: t.endsAt! },
    };
  }
  const phases = pomodoroPhases(t.pomodoro);
  let index = t.pomodoro.phaseIndex;
  let end = t0(t.endsAt);
  for (;;) {
    const at = iso(end);
    const next = phases[index + 1];
    if (!next)
      return {
        patch: {
          state: "completed",
          completedAt: at,
          endsAt: at,
          pomodoro: { ...t.pomodoro, phaseIndex: index },
        },
        completion: { kind: "pomodoro_done", at },
      };
    index++;
    const pomodoro = { ...t.pomodoro, phaseIndex: index };
    if (!autoStarts(t.pomodoro.autoStart, next.phase))
      return {
        patch: {
          state: "paused",
          durationMs: next.ms,
          remainingMs: next.ms,
          endsAt: null,
          startedAt: null,
          pomodoro,
        },
        completion: { kind: "phase_done", next, started: false, at },
      };
    if (end + next.ms > now.getTime())
      return {
        patch: {
          state: "running",
          durationMs: next.ms,
          startedAt: at,
          endsAt: iso(end + next.ms),
          remainingMs: null,
          pomodoro,
        },
        completion: { kind: "phase_done", next, started: true, at },
      };
    end += next.ms;
  }
}

/** "Saltá el descanso": the next phase now (running if it was running, waiting if paused). */
export function skipPhase(t: Timer, now: Date): TimerPatch {
  if (!t.pomodoro || !isActive(t))
    throw new AppError("VALIDATION_ERROR", "There's no Pomodoro phase to skip.", {
      recovery: "review",
    });
  const next = pomodoroPhases(t.pomodoro)[t.pomodoro.phaseIndex + 1];
  const at = now.getTime();
  if (!next) return { state: "completed", completedAt: iso(at), endsAt: iso(at) };
  const pomodoro = { ...t.pomodoro, phaseIndex: t.pomodoro.phaseIndex + 1 };
  return t.state === "running"
    ? {
        durationMs: next.ms,
        startedAt: iso(at),
        endsAt: iso(at + next.ms),
        remainingMs: null,
        pomodoro,
      }
    : { durationMs: next.ms, remainingMs: next.ms, pomodoro };
}

export function applyPatch(t: Timer, patch: TimerPatch, at: Date): Timer {
  return { ...t, ...patch, version: t.version + 1, updatedAt: at.toISOString() };
}

/**
 * What a scheduled end-of-timer run should do. It was scheduled for one version: if the timer
 * moved on since (paused, extended, cancelled, restarted), the run is stale and does nothing.
 */
export function endRunDecision(
  t: Timer | null,
  version: number,
  now: Date,
): "gone" | "stale" | "early" | "due" {
  if (!t) return "gone";
  if (t.version !== version || t.state !== "running" || t.kind === "stopwatch") return "stale";
  return t0(t.endsAt) > now.getTime() ? "early" : "due";
}

// ── Which timer ──────────────────────────────────────────────────────────────

const fold = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

const STOP = new Set([
  "el",
  "la",
  "de",
  "del",
  "timer",
  "temporizador",
  "the",
  "for",
  "para",
  "pomodoro",
  "cronometro",
  "stopwatch",
]);

/**
 * The timer a command means. A name ("el de la pasta") matches the label; without one,
 * the only active timer, else the only one on screen. Several left: a question, never a guess.
 */
export function resolveTimer(
  timers: readonly Timer[],
  ref: string | null | undefined,
  opts: { onScreen?: readonly string[]; kind?: TimerKind } = {},
): Timer {
  const active = timers.filter((t) => isActive(t) && (!opts.kind || t.kind === opts.kind));
  const pool = ref ? timers : active;
  let found = pool;
  if (ref) {
    const byId = timers.find((t) => t.id === ref);
    if (byId) return byId;
    const words = fold(ref)
      .split(" ")
      .filter((w) => w && !STOP.has(w));
    const label = (t: Timer) => fold(t.label ?? "");
    found = words.length
      ? pool.filter((t) => words.every((w) => label(t).includes(w)))
      : pool.filter((t) => fold(ref).includes(t.kind === "stopwatch" ? "crono" : t.kind));
    // Prefer the active ones when an old finished timer shares the name.
    if (found.length > 1 && found.some(isActive)) found = found.filter(isActive);
    if (opts.kind) found = found.filter((t) => t.kind === opts.kind);
  }
  if (found.length === 1) return found[0]!;
  if (!ref && found.length > 1 && opts.onScreen?.length) {
    const visible = found.filter((t) => opts.onScreen!.includes(t.id));
    if (visible.length === 1) return visible[0]!;
  }
  if (!found.length)
    throw new AppError(
      "NOT_FOUND",
      ref ? `No timer called "${ref}".` : "There's no active timer.",
      { recovery: "review" },
    );
  throw new AppError(
    "VALIDATION_ERROR",
    `Several timers match: ${found
      .slice(0, 6)
      .map((t) => t.label ?? t.kind)
      .join(", ")}. Ask which one.`,
    { recovery: "review" },
  );
}

// ── Words ────────────────────────────────────────────────────────────────────

/** 754_000 → "12:34"; 3_754_000 → "1:02:34". Never negative. */
export function clockText(ms: number, roundUp = true): string {
  const total = Math.max(0, roundUp ? Math.ceil(ms / 1000) : Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/** For speech: "12 minutos y 40 segundos", "1 hora y 5 minutos", "40 seconds". */
export function spokenDuration(ms: number, locale: "es" | "en"): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const es = locale === "es";
  const unit = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const parts = [
    h ? unit(h, es ? "hora" : "hour", es ? "horas" : "hours") : null,
    m ? unit(m, es ? "minuto" : "minute", es ? "minutos" : "minutes") : null,
    // Seconds only matter for short times.
    s && h === 0 && m < 20 ? unit(s, es ? "segundo" : "second", es ? "segundos" : "seconds") : null,
  ].filter(Boolean);
  if (!parts.length) return es ? "menos de un segundo" : "less than a second";
  return parts.length === 1
    ? parts[0]!
    : `${parts.slice(0, -1).join(", ")} ${es ? "y" : "and"} ${parts.at(-1)}`;
}

const PHASE_WORDS: Record<PomodoroPhase, { es: string; en: string }> = {
  focus: { es: "foco", en: "focus" },
  short_break: { es: "descanso", en: "break" },
  long_break: { es: "descanso largo", en: "long break" },
};

/** The one short line ELISE says (and the notification shows) when time is up. */
export function completionText(t: Timer, c: Completion, locale: "es" | "en"): string {
  const es = locale === "es";
  const name = t.label ? (es ? ` de ${t.label}` : ` for ${t.label}`) : "";
  if (c.kind === "timer_done")
    return es
      ? `Listo. Se terminaron los ${spokenDuration(t.durationMs, "es")}${name}.`
      : `Done. Your ${spokenDuration(t.durationMs, "en")}${name} are up.`;
  if (c.kind === "pomodoro_done")
    return es
      ? `Terminó el pomodoro${name}. Buen trabajo.`
      : `Pomodoro${name} complete. Nice work.`;
  const next = c.next!;
  const len = spokenDuration(next.ms, locale);
  if (next.phase === "focus")
    return es
      ? `Terminó el descanso. ${c.started ? `Arranca el bloque ${next.cycle}.` : `Cuando quieras, arrancamos el bloque ${next.cycle}.`}`
      : `Break's over. ${c.started ? `Block ${next.cycle} is on.` : `Start block ${next.cycle} when you're ready.`}`;
  return es
    ? `Terminó el bloque. ${c.started ? "Tenés" : "Te toca"} ${len} de ${PHASE_WORDS[next.phase].es}.`
    : `Block done. ${c.started ? "Enjoy" : "Time for"} a ${len} ${PHASE_WORDS[next.phase].en}.`;
}

export function phaseLabel(p: PomodoroPhase, locale: "es" | "en") {
  return PHASE_WORDS[p][locale];
}

// ── Storage port ─────────────────────────────────────────────────────────────

/**
 * The user's timers (implemented in the app layer). `change` writes only if the timer is still
 * at `t.version` — the guard that keeps stale scheduled completions and concurrent tabs from
 * overwriting a newer state. Reads settle overdue timers first.
 */
export interface TimerStore {
  list(opts?: { includeFinished?: boolean }): Promise<Timer[]>;
  create(n: NewTimer): Promise<Timer>;
  change(t: Timer, patch: TimerPatch, event: string): Promise<Timer>;
  preferences(): Promise<TimePreferences>;
}

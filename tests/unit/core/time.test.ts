import { describe, expect, it } from "vitest";

import { executeToolCall } from "@/core/agents/executor";
import { selectTools } from "@/core/agents/tool-selection";
import type { ToolDisplay } from "@/core/agents/tools";
import {
  addTime,
  applyPatch,
  cancel,
  clockText,
  DEFAULT_TIME_PREFERENCES,
  elapsedMs,
  endRunDecision,
  lap,
  pause,
  pomodoroPhases,
  remainingMs,
  reset,
  resolveTimer,
  resume,
  settle,
  skipPhase,
  spokenDuration,
  startState,
  type NewTimer,
  type Timer,
  type TimerPatch,
  type TimerStore,
} from "@/core/timers/model";
import { TIME_TOOLS } from "@/core/tools/time";
import { presentOps, surfacesFromOutcome } from "@/core/workspace/from-results";
import { applyOps, emptyWorkspace, surfaceId } from "@/core/workspace/model";
import { timerFromPayload } from "@/core/workspace/time";

import { makeCtx, makePorts } from "../../fixtures/core-fakes";

const MIN = 60_000;
const T0 = new Date("2026-10-05T12:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);

function make(n: Partial<NewTimer> = {}, now = T0, id = "t1"): Timer {
  const spec: NewTimer = { kind: "timer", label: null, durationMs: 10 * MIN, provenance: {}, ...n };
  return {
    id,
    kind: spec.kind,
    label: spec.label,
    state: "running",
    durationMs: 0,
    startedAt: null,
    endsAt: null,
    remainingMs: null,
    elapsedMs: 0,
    laps: [],
    pomodoro: null,
    version: 1,
    completedAt: null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    provenance: spec.provenance,
    ...startState(spec, now),
  };
}
const step = (t: Timer, p: TimerPatch, now: Date) => applyPatch(t, p, now);

// ── The canonical model ──────────────────────────────────────────────────────

describe("timer from timestamps", () => {
  it("creation sets endsAt; remaining is endsAt − now, at any moment", () => {
    const t = make();
    expect(t.endsAt).toBe(at(10 * MIN).toISOString());
    expect(remainingMs(t, at(3 * MIN))).toBe(7 * MIN);
    // "Reload" = reading the same stored timer later: no countdown was ever stored.
    expect(remainingMs({ ...t }, at(9 * MIN + 30_000))).toBe(30_000);
  });

  it("pause keeps what's left; resume moves the end; still paused across reloads", () => {
    let t = make();
    t = step(t, pause(t, at(4 * MIN)), at(4 * MIN));
    expect(t).toMatchObject({ state: "paused", remainingMs: 6 * MIN, endsAt: null, version: 2 });
    expect(remainingMs(t, at(60 * MIN))).toBe(6 * MIN);
    t = step(t, resume(t, at(60 * MIN)), at(60 * MIN));
    expect(t.endsAt).toBe(at(66 * MIN).toISOString());
    expect(t.version).toBe(3);
  });

  it("add and take time; taking more than is left ends it; a finished one restarts", () => {
    let t = make();
    t = step(t, addTime(t, 5 * MIN, at(MIN)), at(MIN));
    expect(remainingMs(t, at(MIN))).toBe(14 * MIN);
    expect(t.durationMs).toBe(15 * MIN);
    const over = addTime(t, -20 * MIN, at(MIN));
    expect(over.state).toBe("completed");
    const done = step(t, { state: "completed", completedAt: t.endsAt }, at(20 * MIN));
    expect(addTime(done, 5 * MIN, at(30 * MIN))).toMatchObject({
      state: "running",
      endsAt: at(35 * MIN).toISOString(),
    });
  });

  it("cancel; a cancelled timer can't be paused", () => {
    const t = step(make(), cancel(make()), T0);
    expect(t.state).toBe("cancelled");
    expect(() => pause(t, T0)).toThrow(/finished/);
  });

  it("completes at its real end, even when noticed late (sleep); settling twice changes nothing", () => {
    const t = make();
    expect(settle(t, at(9 * MIN)).completion).toBeNull();
    const late = settle(t, at(3 * 60 * MIN));
    expect(late.completion).toMatchObject({ kind: "timer_done", at: t.endsAt });
    expect(late.patch).toMatchObject({ state: "completed", completedAt: t.endsAt });
    const done = step(t, late.patch, at(3 * 60 * MIN));
    expect(settle(done, at(4 * 60 * MIN)).completion).toBeNull();
  });
});

describe("a scheduled end never applies to a newer timer", () => {
  it("due only for the exact version it was scheduled for", () => {
    const t = make();
    expect(endRunDecision(t, 1, at(10 * MIN))).toBe("due");
    expect(endRunDecision(t, 1, at(9 * MIN))).toBe("early");
    expect(endRunDecision(null, 1, at(10 * MIN))).toBe("gone");
  });
  it("stale after pause, after add-time, after cancel, after restart", () => {
    const t = make();
    const now = at(10 * MIN);
    const paused = step(t, pause(t, at(MIN)), at(MIN));
    const extended = step(t, addTime(t, 5 * MIN, at(MIN)), at(MIN));
    const cancelled = step(t, cancel(t), at(MIN));
    const restarted = step(t, reset(t, at(MIN)), at(MIN));
    for (const x of [paused, extended, cancelled, restarted])
      expect(endRunDecision(x, 1, now)).toBe("stale");
    // The run scheduled for the extension is the one that completes it.
    expect(endRunDecision(extended, 2, at(16 * MIN))).toBe("due");
  });
});

describe("Pomodoro", () => {
  const cfg = {
    ...DEFAULT_TIME_PREFERENCES.pomodoro,
    focusMs: 50 * MIN,
    shortBreakMs: 10 * MIN,
    cycles: 2,
  };

  it("custom durations: focus, break, focus, long break — never endless", () => {
    expect(pomodoroPhases(cfg).map((p) => `${p.phase}:${p.ms / MIN}`)).toEqual([
      "focus:50",
      "short_break:10",
      "focus:50",
      "long_break:15",
    ]);
  });

  it("focus ends → the break starts on its own (default); break ends → waits for the user", () => {
    let t = make({ kind: "pomodoro", pomodoro: cfg });
    expect(t.durationMs).toBe(50 * MIN);
    const a = settle(t, at(50 * MIN));
    expect(a.completion).toMatchObject({
      kind: "phase_done",
      started: true,
      next: { phase: "short_break" },
    });
    t = step(t, a.patch, at(50 * MIN));
    expect(remainingMs(t, at(55 * MIN))).toBe(5 * MIN);
    const b = settle(t, at(61 * MIN));
    expect(b.completion).toMatchObject({
      kind: "phase_done",
      started: false,
      next: { phase: "focus", cycle: 2 },
    });
    t = step(t, b.patch, at(61 * MIN));
    expect(t).toMatchObject({ state: "paused", remainingMs: 50 * MIN });
  });

  it("autoStart all: a laptop asleep through several phases lands in the right one", () => {
    const t = make({ kind: "pomodoro", pomodoro: { ...cfg, autoStart: "all" } });
    const s = settle(t, at(75 * MIN)); // 50 focus + 10 break + 15 into focus 2
    expect(s.patch.pomodoro?.phaseIndex).toBe(2);
    expect(s.patch.endsAt).toBe(at(110 * MIN).toISOString());
    const end = settle(t, at(500 * MIN));
    expect(end.completion?.kind).toBe("pomodoro_done");
  });

  it("skip goes to the next phase", () => {
    const t = make({ kind: "pomodoro", pomodoro: cfg });
    expect(skipPhase(t, at(MIN))).toMatchObject({
      durationMs: 10 * MIN,
      pomodoro: { phaseIndex: 1 },
    });
  });
});

describe("stopwatch", () => {
  it("elapsed from timestamps, pause, laps, reset — survives reloads", () => {
    let s = make({ kind: "stopwatch", durationMs: 0 });
    expect(elapsedMs(s, at(90_000))).toBe(90_000);
    s = step(s, lap(s, at(30_000)), at(30_000));
    s = step(s, pause(s, at(60_000)), at(60_000));
    expect(elapsedMs(s, at(10 * MIN))).toBe(60_000);
    s = step(s, resume(s, at(10 * MIN)), at(10 * MIN));
    expect(elapsedMs(s, at(11 * MIN))).toBe(120_000);
    expect(s.laps).toEqual([30_000]);
    expect(reset(s, at(11 * MIN))).toMatchObject({ elapsedMs: 0, laps: [] });
    expect(() => addTime(s, MIN, T0)).toThrow(/stopwatch/);
  });
});

describe("which timer", () => {
  const pasta = { ...make({ label: "Pasta" }, T0, "a") };
  const laundry = { ...make({ label: "Lavarropas" }, T0, "b") };
  const old = { ...make({ label: "Pasta" }, T0, "c"), state: "completed" as const };

  it("the only active one; by label; never the wrong one silently", () => {
    expect(resolveTimer([pasta, old], undefined).id).toBe("a");
    expect(resolveTimer([pasta, laundry, old], "el de la pasta").id).toBe("a");
    expect(resolveTimer([pasta, laundry], "lavarropas").id).toBe("b");
    expect(() => resolveTimer([pasta, laundry], undefined)).toThrow(/Several timers/);
    expect(() => resolveTimer([pasta], "horno")).toThrow(/No timer/);
  });

  it("several active: the one on screen", () => {
    expect(resolveTimer([pasta, laundry], undefined, { onScreen: ["b"] }).id).toBe("b");
  });
});

describe("words", () => {
  it("speaks time left exactly", () => {
    expect(spokenDuration(12 * MIN + 40_000, "es")).toBe("12 minutos y 40 segundos");
    expect(spokenDuration(17 * MIN, "es")).toBe("17 minutos");
    expect(spokenDuration(65 * MIN, "en")).toBe("1 hour and 5 minutes");
    expect(clockText(18 * MIN + 41_200)).toBe("18:42");
    expect(clockText(3_754_000)).toBe("1:02:34");
  });
});

// ── Tools, through the executor ──────────────────────────────────────────────

/** In memory, with the same version guard as the database. */
class MemoryTimers implements TimerStore {
  timers = new Map<string, Timer>();
  n = 0;
  constructor(private readonly clock: () => Date) {}
  async list(opts: { includeFinished?: boolean } = {}) {
    const now = this.clock();
    for (const t of this.timers.values()) {
      const s = settle(t, now);
      if (s.completion) this.timers.set(t.id, applyPatch(t, s.patch, now));
    }
    return [...this.timers.values()].filter(
      (t) => opts.includeFinished || t.state === "running" || t.state === "paused",
    );
  }
  async create(n: NewTimer) {
    const id = `00000000-0000-4000-8000-00000000000${++this.n}`;
    const t = { ...make(n, this.clock(), id), provenance: n.provenance };
    this.timers.set(id, t);
    return t;
  }
  async change(t: Timer, patch: TimerPatch) {
    const cur = this.timers.get(t.id)!;
    if (cur.version !== t.version) throw new Error("conflict");
    const next = applyPatch(cur, patch, this.clock());
    this.timers.set(t.id, next);
    return next;
  }
  async preferences() {
    return DEFAULT_TIME_PREFERENCES;
  }
}

function setup() {
  let now = T0;
  const store = new MemoryTimers(() => now);
  const { ports } = makePorts([], { internal: store });
  const call = (name: string, args: unknown, ctx: Partial<Parameters<typeof makeCtx>[0]> = {}) =>
    executeToolCall(ports, makeCtx({ now, ...ctx }), { name, args });
  return { store, call, advance: (ms: number) => (now = new Date(now.getTime() + ms)) };
}
const out = (r: unknown) => (r as { output: Record<string, unknown> }).output;
const display = (r: unknown) => (r as { display: ToolDisplay }).display;

describe("time.* tools", () => {
  it("“poneme 25 minutos para estudiar Legislación” → a timer, a quick reply, no approval", async () => {
    const { call } = setup();
    const r = await call(
      "time.start",
      { minutes: 25, label: "Legislación" },
      { conversationId: "c1" },
    );
    expect(r.status).toBe("succeeded");
    expect(out(r).say).toBe("Dale. 25 minutos.");
    expect(display(r)).toMatchObject({
      kind: "timer",
      timer: { label: "Legislación", state: "running" },
    });
  });

  it("belongs to the user: another conversation sees and controls the same timer", async () => {
    const { call, advance } = setup();
    await call("time.start", { minutes: 25 }, { conversationId: "c1" });
    advance(8 * MIN);
    const left = await call("time.list", {}, { conversationId: "c2" });
    expect(out(left).timers).toMatchObject([{ remaining: "17:00", remainingSpoken: "17 minutos" }]);
    const added = await call("time.addTime", { minutes: 5 }, { conversationId: "c2" });
    expect(out(added).say).toBe("Listo. Quedan 22 minutos.");
    const paused = await call("time.control", { action: "pause" }, { conversationId: "c3" });
    expect(display(paused)).toMatchObject({ timer: { state: "paused", remainingMs: 22 * MIN } });
  });

  it("several timers: by name, else a question (never the wrong one)", async () => {
    const { call } = setup();
    await call("time.start", { minutes: 8, label: "Pasta" });
    await call("time.start", { minutes: 40, label: "Lavarropas" });
    const r = await call("time.addTime", { minutes: 10, timer: "lavarropas" });
    expect(display(r)).toMatchObject({ timer: { label: "Lavarropas", durationMs: 50 * MIN } });
    const unclear = await call("time.control", { action: "cancel" });
    expect(unclear.status).toBe("failed");
    expect(JSON.stringify(unclear)).toMatch(/Several timers/);
  });

  it("Pomodoro with defaults and custom; stopwatch", async () => {
    const { call } = setup();
    const p = await call("time.start", {
      kind: "pomodoro",
      focusMinutes: 50,
      breakMinutes: 10,
      label: "AMII",
    });
    expect(display(p)).toMatchObject({
      timer: { durationMs: 50 * MIN, pomodoro: { shortBreakMs: 10 * MIN, cycles: 4 } },
    });
    const s = await call("time.start", { kind: "stopwatch" });
    expect(out(s).say).toMatch(/cronómetro/);
  });

  it("clock: the exact time where asked", async () => {
    const { call } = setup();
    const r = await call("time.now", { place: "Auckland", show: true });
    expect(out(r)).toMatchObject({ timezone: "Pacific/Auckland", time: "01:00" });
    expect(display(r)).toMatchObject({ kind: "clock", clock: { timezone: "Pacific/Auckland" } });
  });
});

describe("the Timer Surface", () => {
  it("one Surface per timer: changes update it in place, never a duplicate", async () => {
    const { call } = setup();
    const created = await call("time.start", { minutes: 2, label: "Prueba" });
    const draft = (r: unknown) =>
      surfacesFromOutcome("time.x", r as Parameters<typeof surfacesFromOutcome>[1], {
        key: "k",
        locale: "es",
      });
    let ws = applyOps(emptyWorkspace(), presentOps(draft(created), T0.toISOString()));
    const added = await call("time.addTime", { minutes: 1 });
    ws = applyOps(ws, presentOps(draft(added), T0.toISOString()));
    const listed = await call("time.list", {});
    ws = applyOps(ws, presentOps(draft(listed), T0.toISOString()));
    const timers = ws.surfaces.filter((s) => s.type === "timer");
    const id = (display(created) as { timer: { id: string } }).timer.id;
    expect(timers).toHaveLength(1);
    expect(timers[0]!.id).toBe(surfaceId("timer", id));
    expect(timerFromPayload(timers[0]!.payload as never).durationMs).toBe(3 * MIN);
  });

  it("a running timer stays on the Canvas while the conversation moves on", async () => {
    const { call } = setup();
    const created = await call("time.start", { minutes: 30 });
    const drafts = surfacesFromOutcome("time.start", created as never, { key: "k", locale: "es" });
    let ws = applyOps(emptyWorkspace(), presentOps(drafts, T0.toISOString()));
    for (let i = 0; i < 8; i++) ws = applyOps(ws, [{ op: "turn", at: T0.toISOString() }]);
    expect(ws.surfaces.some((s) => s.type === "timer")).toBe(true);
  });

  it("time tools are on every turn (“¿cuánto falta?” names no keyword)", () => {
    const sel = selectTools(TIME_TOOLS, { message: "¿cuánto falta?" });
    expect(sel.tools.map((t) => t.name)).toContain("time.list");
  });
});

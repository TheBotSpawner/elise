import { describe, expect, it } from "vitest";

import { executeToolCall } from "@/core/agents/executor";
import { selectTools } from "@/core/agents/tool-selection";
import type { ProviderFactory, ToolDisplay } from "@/core/agents/tools";
import { assembleBrief } from "@/core/briefs/morning-brief";
import {
  createsCycle,
  drivesProgress,
  goalProblems,
  goalProgress,
  NO_LINKS,
  type Goal,
  type GoalPatch,
  type GoalsProvider,
  type LinkedStatus,
  type NewGoal,
  type NewVision,
  type ProgressEvent,
  type Relationship,
  type Vision,
} from "@/core/capabilities/goals";
import {
  habitProgress,
  type Habit,
  type HabitEntry,
  type HabitsProvider,
} from "@/core/capabilities/habits";
import {
  filterGoals,
  goalHealth,
  goalsSummary,
  habitContribution,
  inferGoalDraft,
  progressSeries,
  sortGoals,
  suggestGoalIcon,
  visionSummaries,
  type GoalSnapshot,
} from "@/core/goals/analytics";
import { periodLabel, presetOf, quarterName, resolveGoalPeriod } from "@/core/goals/periods";
import { surfacesFromOutcome } from "@/core/workspace/from-results";
import { changeOf, decide } from "@/core/workspace/lifecycle";
import type { Surface } from "@/core/workspace/model";

import { binding, makeCtx, makePorts, NATIVE_BINDING } from "../../fixtures/core-fakes";

const TODAY = "2026-10-13";

const goal = (over: Partial<Goal> = {}): Goal => ({
  id: "g1",
  title: "Conseguir 12 clientes",
  description: null,
  status: "active",
  targetDate: null,
  progressType: "numeric",
  progressMode: "manual",
  startValue: null,
  currentValue: 0,
  targetValue: 12,
  direction: "increase",
  metric: "clientes",
  currency: null,
  icon: null,
  area: null,
  periodStart: null,
  periodEnd: null,
  parentGoalId: null,
  completedAt: null,
  archived: false,
  links: [],
  createdAt: "2026-01-01T12:00:00Z",
  updatedAt: "2026-01-01T12:00:00Z",
  ...over,
});

const habit = (over: Partial<Habit> = {}): Habit => ({
  id: "h1",
  name: "Workout",
  description: null,
  frequency: "weekly",
  target: 3,
  unit: null,
  preferredDays: [],
  active: true,
  startDate: "2026-01-01",
  createdAt: "2026-01-01T00:00:00Z",
  icon: "🏋️",
  pausedUntil: null,
  archived: false,
  ...over,
});

const done = (date: string, value = 1, habitId = "h1"): HabitEntry => ({
  id: `${habitId}-${date}`,
  habitId,
  date,
  value,
  status: "done",
  notes: null,
  source: "user_ui",
});

const snap = (g: Goal, status: LinkedStatus = NO_LINKS, today = TODAY): GoalSnapshot => {
  const progress = goalProgress(g, status);
  return {
    goal: g,
    progress,
    health: goalHealth(g, progress, today),
    openTasks: 0,
    habits: status.habits,
  };
};

// ── Periods ──────────────────────────────────────────────────────────────────

describe("goal periods", () => {
  it("resolves presets in local dates, deterministically", () => {
    expect(resolveGoalPeriod("this_quarter", TODAY)).toEqual({
      from: "2026-10-01",
      to: "2026-12-31",
    });
    expect(resolveGoalPeriod("next_quarter", TODAY)).toEqual({
      from: "2027-01-01",
      to: "2027-03-31",
    });
    expect(resolveGoalPeriod("this_year", TODAY)).toEqual({ from: "2026-01-01", to: "2026-12-31" });
    expect(resolveGoalPeriod("next_year", TODAY)).toEqual({ from: "2027-01-01", to: "2027-12-31" });
    // Q1 asked in October is the next Q1; Q4 is this one.
    expect(resolveGoalPeriod("q1", TODAY)).toEqual({ from: "2027-01-01", to: "2027-03-31" });
    expect(resolveGoalPeriod("q4", TODAY)).toEqual({ from: "2026-10-01", to: "2026-12-31" });
    expect(resolveGoalPeriod("q2", TODAY, { year: 2026 })).toEqual({
      from: "2026-04-01",
      to: "2026-06-30",
    });
    expect(resolveGoalPeriod("months_3", TODAY)).toEqual({ from: TODAY, to: "2027-01-12" });
    expect(resolveGoalPeriod("months_12", "2026-01-31")).toEqual({
      from: "2026-01-31",
      to: "2027-01-30",
    });
    expect(resolveGoalPeriod("none", TODAY)).toBeNull();
    expect(
      resolveGoalPeriod("custom", TODAY, { from: "2026-11-01", to: "2026-10-01" }),
    ).toBeUndefined();
  });

  it("labels come from the dates, never stored text", () => {
    expect(periodLabel({ from: "2026-10-01", to: "2026-12-31" }, "es")).toBe("T4 2026");
    expect(periodLabel({ from: "2026-10-01", to: "2026-12-31" }, "en")).toBe("Q4 2026");
    expect(periodLabel({ from: "2027-01-01", to: "2027-12-31" }, "es")).toBe("2027");
    expect(periodLabel({ from: "2027-01-01", to: "2027-06-30" }, "es")).toBe("T1–T2 2027");
    expect(periodLabel({ from: "2026-10-01", to: "2026-11-30" }, "es")).toBe("oct–nov 2026");
    expect(periodLabel({ from: "2026-10-13", to: "2027-01-12" }, "es")).toBe(
      "13 oct 2026 – 12 ene 2027",
    );
    expect(quarterName(1, "es")).toBe("T1 · enero–marzo");
    expect(presetOf({ from: "2026-10-01", to: "2026-12-31" }, TODAY)).toBe("this_quarter");
    expect(presetOf({ from: "2026-10-05", to: "2026-12-31" }, TODAY)).toBe("custom");
  });
});

// ── Progress per measure ─────────────────────────────────────────────────────

describe("goal progress", () => {
  it("binary, numeric, percentage, currency and lower-is-better", () => {
    expect(goalProgress(goal({ progressType: "binary" }), NO_LINKS).percent).toBe(0);
    expect(
      goalProgress(goal({ progressType: "binary", status: "completed" }), NO_LINKS).percent,
    ).toBe(100);
    expect(goalProgress(goal({ currentValue: 7 }), NO_LINKS)).toMatchObject({
      percent: 58,
      value: 7,
    });
    expect(
      goalProgress(goal({ progressType: "percentage", currentValue: 68 }), NO_LINKS).percent,
    ).toBe(68);
    expect(
      goalProgress(
        goal({ currency: "ARS", metric: null, targetValue: 10_000_000, currentValue: 2_500_000 }),
        NO_LINKS,
      ).percent,
    ).toBe(25);
    // 45 → 30 min, now 38: 7 of 15 minutes gone. Never naive current / target.
    const faster = goal({
      direction: "decrease",
      startValue: 45,
      currentValue: 38,
      targetValue: 30,
    });
    expect(goalProgress(faster, NO_LINKS).percent).toBe(47);
    expect(goalProgress({ ...faster, currentValue: 30 }, NO_LINKS)).toMatchObject({
      percent: 100,
      reached: true,
    });
    expect(goalProgress(goal({ currentValue: 12 }), NO_LINKS).reached).toBe(true);
  });

  it("linked habits add 1 per met day inside the goal's window (36 workouts in 12 weeks)", () => {
    const g = goal({
      title: "Entrenar 36 veces",
      targetValue: 36,
      metric: "entrenamientos",
      progressMode: "linked",
      currentValue: null,
      periodStart: "2026-09-01",
      periodEnd: "2026-11-23",
    });
    const entries = [
      ...Array.from({ length: 14 }, (_, i) => done(`2026-09-${String(i + 2).padStart(2, "0")}`)),
      done("2026-08-30"), // before the period: doesn't count
    ];
    const dated = habitContribution(habit(), entries, g.metric, { from: "2026-09-01", to: TODAY });
    expect(dated).toHaveLength(14);
    const status: LinkedStatus = {
      tasks: { total: 0, completed: 0, open: [] },
      habits: [{ id: "h1", name: "Workout", done: 2, goal: 3, drives: true, contribution: 14 }],
    };
    expect(goalProgress(g, status)).toMatchObject({
      value: 14,
      percent: 39,
      basis: "linked",
      linkedValue: 14,
    });
    // A context-only habit adds nothing.
    expect(
      goalProgress(g, { ...status, habits: [{ ...status.habits[0]!, drives: false }] }).percent,
    ).toBeNull();
  });

  it("same-unit habits add their quantity; hybrid adds linked to the manual value", () => {
    const km = habit({ unit: "km", frequency: "daily", target: 5 });
    expect(
      habitContribution(km, [done("2026-10-01", 3.5), done("2026-10-02", 6)], "km", {
        from: "2026-10-01",
        to: TODAY,
      }),
    ).toEqual([
      { date: "2026-10-01", amount: 3.5 },
      { date: "2026-10-02", amount: 6 },
    ]);
    // Different unit: a met day counts 1 (3.5 < 5 isn't met).
    expect(
      habitContribution(km, [done("2026-10-01", 3.5), done("2026-10-02", 6)], "sessions", {
        from: "2026-10-01",
        to: TODAY,
      }),
    ).toHaveLength(1);
    const hybrid = goal({ progressMode: "hybrid", currentValue: 4 });
    const status: LinkedStatus = { tasks: { total: 3, completed: 2, open: ["x"] }, habits: [] };
    expect(goalProgress(hybrid, status)).toMatchObject({ value: 6, percent: 50, basis: "hybrid" });
  });

  it("validates deterministically", () => {
    expect(goalProblems({ progressType: "numeric", targetValue: 0 })).toContain("target_positive");
    expect(goalProblems({ progressType: "numeric", targetValue: null })).toContain(
      "target_required",
    );
    expect(
      goalProblems({ progressType: "numeric", direction: "decrease", targetValue: 30 }),
    ).toContain("start_required");
    expect(
      goalProblems({
        progressType: "numeric",
        direction: "decrease",
        startValue: 20,
        targetValue: 30,
      }),
    ).toContain("target_direction");
    expect(goalProblems({ progressType: "percentage", currentValue: 120 })).toContain(
      "percentage_range",
    );
    expect(goalProblems({ periodStart: "2026-12-01", periodEnd: "2026-10-01" })).toContain(
      "period_order",
    );
    expect(goalProblems({ progressType: "numeric", targetValue: 12, currentValue: 3 })).toEqual([]);
  });

  it("prevents circular parent chains", () => {
    const parents = new Map([
      ["a", null],
      ["b", "a"],
      ["c", "b"],
    ]);
    expect(createsCycle("a", "c", parents)).toBe(true);
    expect(createsCycle("c", "a", parents)).toBe(false);
  });
});

// ── Health / risk ────────────────────────────────────────────────────────────

describe("goal health", () => {
  const q4 = { periodStart: "2026-10-01", periodEnd: "2026-12-31", targetDate: "2026-12-31" };

  it("75% of the period gone with 20% done is at risk, and says why", () => {
    const g = goal({ ...q4, currentValue: 2, targetValue: 10 });
    const h = goalHealth(g, goalProgress(g, NO_LINKS), "2026-12-08");
    expect(h.state).toBe("at_risk");
    expect(h.reason).toMatchObject({ kind: "pace", progress: 0.2 });
    expect(h.elapsed!).toBeGreaterThan(0.74);
  });

  it("keeping pace is on track; too early or nothing to measure claims no risk", () => {
    const g = goal({ ...q4, currentValue: 6, targetValue: 10 });
    expect(goalHealth(g, goalProgress(g, NO_LINKS), "2026-12-08").state).toBe("on_track");
    const early = goal({ ...q4, currentValue: 0 });
    expect(goalHealth(early, goalProgress(early, NO_LINKS), "2026-10-05").state).toBe(
      "not_started",
    );
    const binary = goal({ ...q4, progressType: "binary" });
    expect(goalHealth(binary, goalProgress(binary, NO_LINKS), "2026-12-20").state).toBe(
      "in_progress",
    );
  });

  it("overdue, future, reached, paused, archived", () => {
    const g = goal({ ...q4, currentValue: 3 });
    expect(goalHealth(g, goalProgress(g, NO_LINKS), "2027-01-05")).toMatchObject({
      state: "at_risk",
      reason: { kind: "overdue", deadline: "2026-12-31" },
    });
    const later = goal({ periodStart: "2027-01-01", periodEnd: "2027-03-31" });
    expect(goalHealth(later, goalProgress(later, NO_LINKS), TODAY).state).toBe("not_started");
    const reached = goal({ ...q4, currentValue: 12 });
    expect(goalHealth(reached, goalProgress(reached, NO_LINKS), TODAY)).toMatchObject({
      state: "on_track",
      reached: true,
    });
    expect(
      goalHealth(goal({ status: "paused" }), goalProgress(goal(), NO_LINKS), TODAY).state,
    ).toBe("paused");
    expect(goalHealth(goal({ archived: true }), goalProgress(goal(), NO_LINKS), TODAY).state).toBe(
      "archived",
    );
  });
});

// ── Analytics ────────────────────────────────────────────────────────────────

describe("goal analytics", () => {
  const vision: Vision = {
    id: "v1",
    title: "Firbot Solutions es una agencia rentable",
    description: null,
    icon: "🚀",
    area: null,
    status: "active",
    achievedAt: null,
    createdAt: "",
    updatedAt: "",
  };
  const link = (id: string) => ({
    id: `l-${id}`,
    resourceType: "vision" as const,
    resourceId: id,
    relationship: "supports" as const,
    title: null,
  });
  const snaps = [
    snap(
      goal({
        id: "a",
        title: "Clientes",
        periodStart: "2026-10-01",
        periodEnd: "2026-12-31",
        targetDate: "2026-12-31",
        currentValue: 1,
        links: [link("v1")],
      }),
      NO_LINKS,
      "2026-12-08",
    ),
    snap(
      goal({
        id: "b",
        title: "Artículos",
        area: "Marketing",
        periodStart: "2027-01-01",
        periodEnd: "2027-12-31",
        currentValue: 0,
      }),
      NO_LINKS,
      "2026-12-08",
    ),
    snap(
      goal({
        id: "c",
        title: "Curso",
        status: "completed",
        completedAt: "2026-12-01T00:00:00Z",
        links: [link("v1")],
      }),
      NO_LINKS,
      "2026-12-08",
    ),
  ];

  it("filters by status, period, Vision, area and search; sorts by attention", () => {
    const q4 = resolveGoalPeriod("this_quarter", TODAY)!;
    expect(filterGoals(snaps, { status: "active", range: q4 }).map((s) => s.goal.id)).toEqual(
      ["a", "c"].slice(0, 1),
    );
    expect(filterGoals(snaps, { status: "at_risk" }).map((s) => s.goal.id)).toEqual(["a"]);
    expect(filterGoals(snaps, { visionId: "v1" }).map((s) => s.goal.id)).toEqual(["a", "c"]);
    expect(filterGoals(snaps, { area: "marketing" }).map((s) => s.goal.id)).toEqual(["b"]);
    expect(filterGoals(snaps, { query: "firbot" }, [vision]).map((s) => s.goal.id)).toEqual([
      "a",
      "c",
    ]);
    expect(sortGoals(snaps, "attention")[0]!.goal.id).toBe("a");
  });

  it("summarizes without a Vision percentage", () => {
    expect(goalsSummary(snaps)).toMatchObject({ active: 2, atRisk: 1, completed: 1 });
    expect(visionSummaries([vision], snaps)[0]).toMatchObject({
      active: 1,
      completed: 1,
      total: 2,
      atRisk: 1,
    });
  });

  it("history: manual events plus linked amounts as they accrued", () => {
    const g = goal({ progressMode: "hybrid" });
    const ev = (at: string, v: number): ProgressEvent => ({
      id: at,
      goalId: "g1",
      previousValue: null,
      newValue: v,
      sourceType: "manual",
      sourceId: null,
      note: null,
      occurredAt: at,
    });
    const series = progressSeries(
      g,
      [ev("2026-09-01T15:00:00Z", 3), ev("2026-10-10T15:00:00Z", 5)],
      [{ date: "2026-09-20", amount: 1 }],
      "America/Argentina/Buenos_Aires",
    );
    expect(series).toEqual([
      { date: "2026-09-01", value: 3 },
      { date: "2026-09-20", value: 4 },
      { date: "2026-10-10", value: 6 },
    ]);
  });

  it("suggests icons and form defaults from the title, never deciding for the user", () => {
    expect(inferGoalDraft("Leer 12 libros este año", TODAY)).toMatchObject({
      progressType: "numeric",
      targetValue: 12,
      metric: "libros",
      period: "this_year",
    });
    expect(inferGoalDraft("Alcanzar ARS 10.000.000 mensuales", TODAY)).toMatchObject({
      currency: "ARS",
      targetValue: 10_000_000,
    });
    expect(inferGoalDraft("Llegar a 20 alumnos de acá a diciembre", TODAY)).toMatchObject({
      period: "custom",
      to: "2026-12-31",
    });
    expect(inferGoalDraft("Lanzar la web", TODAY).progressType).toBe("binary");
    expect(suggestGoalIcon("Publicar 8 artículos")).toBe("📰");
    expect(suggestGoalIcon("Leer 12 libros")).toBe("📚");
  });
});

// ── Tools through the executor ───────────────────────────────────────────────

class MemoryGoals implements GoalsProvider {
  goals: Goal[] = [];
  visions: Vision[] = [];
  events: ProgressEvent[] = [];
  constructor(private readonly habits: MemoryHabits) {}
  async list({ status, archived = false }: { status: Goal["status"] | "all"; archived?: boolean }) {
    return this.goals.filter(
      (g) => Boolean(g.archived) === archived && (status === "all" || g.status === status),
    );
  }
  async find(ref: string) {
    return this.goals.filter(
      (g) => !g.archived && (g.id === ref || g.title.toLowerCase().includes(ref.toLowerCase())),
    );
  }
  async create(g: NewGoal) {
    const created = goal({
      ...g,
      id: crypto.randomUUID(),
      links: [],
      createdAt: "2026-10-13T12:00:00Z",
    } as Partial<Goal>);
    this.goals.push(created);
    return created;
  }
  async update(id: string, p: GoalPatch) {
    const g = this.goals.find((x) => x.id === id)!;
    Object.assign(g, Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined)));
    if (p.status) g.completedAt = p.status === "completed" ? "2026-10-13T12:00:00Z" : null;
    return g;
  }
  async archive(id: string) {
    return this.update(id, {}).then((g) => Object.assign(g, { archived: true }));
  }
  async link(
    goalId: string,
    l: {
      resourceType: Goal["links"][number]["resourceType"];
      resourceId: string;
      relationship: Relationship;
    },
  ) {
    const g = this.goals.find((x) => x.id === goalId)!;
    const existing = g.links.find(
      (x) => x.resourceType === l.resourceType && x.resourceId === l.resourceId,
    );
    if (existing) existing.relationship = l.relationship;
    else g.links.push({ id: crypto.randomUUID(), ...l, title: null });
    return g;
  }
  async unlink(goalId: string, l: { resourceType: string; resourceId: string }) {
    const g = this.goals.find((x) => x.id === goalId)!;
    g.links = g.links.filter(
      (x) => !(x.resourceType === l.resourceType && x.resourceId === l.resourceId),
    );
    return g;
  }
  async linkedStatus(g: Goal, today: string): Promise<LinkedStatus> {
    const counts = g.progressType === "numeric" && g.direction !== "decrease";
    return {
      tasks: { total: 0, completed: 0, open: [] },
      habits: g.links
        .filter((l) => l.resourceType === "habit")
        .map((l) => {
          const h = this.habits.habits.find((x) => x.id === l.resourceId)!;
          const drives = counts && drivesProgress(l);
          const week = habitProgress(h, this.habits.stored, today).week;
          const contribution = drives
            ? habitContribution(h, this.habits.stored, g.metric, {
                from: g.periodStart ?? "2026-01-01",
                to: today,
              }).length
            : 0;
          return {
            id: h.id,
            name: h.name,
            icon: h.icon,
            done: week.done,
            goal: week.goal,
            drives,
            contribution,
          };
        }),
    };
  }
  async findTasks() {
    return [];
  }
  async history(goalId: string) {
    return this.events.filter((e) => e.goalId === goalId).reverse();
  }
  async record(
    goalId: string,
    e: Omit<ProgressEvent, "id" | "goalId" | "occurredAt" | "sourceId" | "note"> & {
      note?: string | null;
    },
  ) {
    this.events.push({
      id: crypto.randomUUID(),
      goalId,
      sourceId: null,
      note: e.note ?? null,
      occurredAt: "2026-10-13T12:00:00Z",
      ...e,
    });
  }
  async listVisions() {
    return this.visions;
  }
  async findVision(ref: string) {
    return this.visions.filter(
      (v) => v.id === ref || v.title.toLowerCase().includes(ref.toLowerCase()),
    );
  }
  async createVision(v: NewVision) {
    const created: Vision = {
      id: crypto.randomUUID(),
      title: v.title,
      description: v.description ?? null,
      icon: v.icon ?? null,
      area: v.area ?? null,
      status: "active",
      achievedAt: null,
      createdAt: "",
      updatedAt: "",
    };
    this.visions.push(created);
    return created;
  }
}

class MemoryHabits implements Partial<HabitsProvider> {
  habits: Habit[] = [habit()];
  stored: HabitEntry[] = [];
  async list() {
    return this.habits;
  }
  async find(ref: string) {
    return this.habits.filter(
      (h) => h.id === ref || h.name.toLowerCase().includes(ref.toLowerCase()),
    );
  }
  async entries() {
    return this.stored;
  }
  async checkIn(habitId: string, e: { date: string; value: number }) {
    const created = done(e.date, e.value, habitId);
    this.stored.push(created);
    return created;
  }
}

function goalPorts() {
  const habits = new MemoryHabits();
  const goals = new MemoryGoals(habits);
  const bindings = ["habits", "goals"].map((capability) =>
    binding({
      connectionId: "conn-native",
      capability: capability as "habits",
      providerKey: "elise_native",
      label: "ELISE",
      isDefault: true,
    }),
  );
  const { ports } = makePorts([NATIVE_BINDING, ...bindings]);
  ports.providers = {
    get: ((c: string) => (c === "habits" ? habits : goals)) as ProviderFactory["get"],
  };
  return { ports, goals, habits };
}

const ctx = makeCtx({ now: new Date("2026-10-13T15:00:00Z") });

describe("goal tools (voice / chat)", () => {
  it("creates a goal in one call: period, deadline, icon, the clearly matching Vision, habits", async () => {
    const { ports, goals } = goalPorts();
    await goals.createVision({ title: "Firbot Academy es la academia de referencia" });
    const out = await executeToolCall(ports, ctx, {
      name: "goals.create",
      args: {
        title: "Conseguir 20 alumnos nuevos en Academy",
        progressType: "numeric",
        targetValue: 20,
        metric: "alumnos",
        period: "this_year",
        visions: ["Firbot Academy", "Inexistente"],
        habits: [{ habit: "workout", useForProgress: true }],
      },
    });
    expect(out.status).toBe("succeeded");
    const g = goals.goals[0]!;
    expect(g).toMatchObject({
      periodStart: "2026-01-01",
      periodEnd: "2026-12-31",
      targetDate: "2026-12-31",
      icon: "🎓",
    });
    expect(g.links.map((l) => [l.resourceType, l.relationship])).toEqual([
      ["vision", "supports"],
      ["habit", "supports"],
    ]);
    // Something drives it now: its progress source follows the links.
    expect(g.progressMode).toBe("linked");
    expect(out.status === "succeeded" && (out.output as { notes: string[] }).notes[0]).toContain(
      "Inexistente",
    );
  });

  it("updates progress with a note, appends history, and never completes on its own", async () => {
    const { ports, goals } = goalPorts();
    await executeToolCall(ports, ctx, {
      name: "goals.create",
      args: { title: "Clientes", progressType: "numeric", targetValue: 12 },
    });
    await executeToolCall(ports, ctx, {
      name: "goals.updateProgress",
      args: { goal: "clientes", value: 7, note: "Cerré ACME" },
    });
    const out = await executeToolCall(ports, ctx, {
      name: "goals.updateProgress",
      args: { goal: "clientes", add: 5 },
    });
    expect(goals.goals[0]).toMatchObject({ currentValue: 12, status: "active" });
    expect(goals.events.map((e) => [e.previousValue, e.newValue, e.note])).toEqual([
      [null, 0, null],
      [0, 7, "Cerré ACME"],
      [7, 12, null],
    ]);
    expect(out.status === "succeeded" && (out.output as { note?: string }).note).toContain(
      "Target reached",
    );
  });

  it("moves a goal to next quarter: the deadline follows the period", async () => {
    const { ports, goals } = goalPorts();
    await executeToolCall(ports, ctx, {
      name: "goals.create",
      args: {
        title: "Publicar 8 artículos",
        progressType: "numeric",
        targetValue: 8,
        period: "this_quarter",
      },
    });
    await executeToolCall(ports, ctx, {
      name: "goals.update",
      args: { goal: "artículos", period: "next_quarter" },
    });
    expect(goals.goals[0]).toMatchObject({
      periodStart: "2027-01-01",
      periodEnd: "2027-03-31",
      targetDate: "2027-03-31",
    });
  });

  it("links never duplicate, and a parent chain can't loop", async () => {
    const { ports, goals } = goalPorts();
    await executeToolCall(ports, ctx, {
      name: "goals.create",
      args: { title: "A", progressType: "numeric", targetValue: 3 },
    });
    await executeToolCall(ports, ctx, {
      name: "goals.create",
      args: { title: "B", progressType: "numeric", targetValue: 3, parentGoal: "A" },
    });
    for (let i = 0; i < 2; i++)
      await executeToolCall(ports, ctx, {
        name: "goals.linkResource",
        args: { goal: "A", resourceType: "habit", resource: "workout" },
      });
    expect(goals.goals[0]!.links).toHaveLength(1);
    // Contextual by default: a habit doesn't count unless asked.
    expect(goals.goals[0]!.links[0]!.relationship).toBe("related");
    const loop = await executeToolCall(ports, ctx, {
      name: "goals.update",
      args: { goal: "A", parentGoal: "B" },
    });
    expect(loop.status).toBe("failed");
  });

  it("habits relate back to goals through the same links (both directions agree)", async () => {
    const { ports, goals } = goalPorts();
    await executeToolCall(ports, ctx, {
      name: "goals.create",
      args: {
        title: "Entrenar 36 veces",
        progressType: "numeric",
        targetValue: 36,
        period: "this_quarter",
      },
    });
    await executeToolCall(ports, ctx, {
      name: "habits.update",
      args: { habit: "workout", goals: [{ goal: "entrenar", useForProgress: true }] },
    });
    expect(goals.goals[0]!.links).toEqual([
      expect.objectContaining({
        resourceType: "habit",
        resourceId: "h1",
        relationship: "supports",
      }),
    ]);
    // A check-in now moves the goal, computed in code.
    await executeToolCall(ports, ctx, { name: "habits.checkIn", args: { habit: "workout" } });
    const out = await executeToolCall(ports, ctx, {
      name: "goals.getProgress",
      args: { goal: "entrenar" },
    });
    const display =
      out.status === "succeeded" ? (out.display as Extract<ToolDisplay, { kind: "goal" }>) : null;
    expect(display?.detail.snapshot.progress).toMatchObject({ value: 1, basis: "linked" });
    // Removing it from the habit side removes it from the goal, and the goal is manual again.
    await executeToolCall(ports, ctx, {
      name: "habits.update",
      args: { habit: "workout", goals: [] },
    });
    expect(goals.goals[0]!.links).toEqual([]);
    expect(goals.goals[0]!.progressMode).toBe("manual");
  });

  it("lists goals at risk and a Vision's goals, with health from code", async () => {
    const { ports, goals } = goalPorts();
    goals.goals.push(
      goal({ id: "r", title: "Atrasado", targetDate: "2026-10-01", currentValue: 1 }),
    );
    goals.goals.push(goal({ id: "s", title: "Sin fecha", currentValue: 1 }));
    const out = await executeToolCall(ports, ctx, {
      name: "goals.list",
      args: { status: "at_risk" },
    });
    const d =
      out.status === "succeeded" ? (out.display as Extract<ToolDisplay, { kind: "goals" }>) : null;
    expect(d?.goals.map((g) => g.goal.id)).toEqual(["r"]);
    expect(d?.scope).toMatchObject({ status: "at_risk" });
  });
});

// ── Canvas Surfaces and lifecycle ────────────────────────────────────────────

describe("goal Surfaces", () => {
  it("one Surface per goal, per Vision and per list scope: presenting again updates, never duplicates", async () => {
    const { ports } = goalPorts();
    const created = await executeToolCall(ports, ctx, {
      name: "goals.create",
      args: { title: "Clientes", progressType: "numeric", targetValue: 12 },
    });
    const updated = await executeToolCall(ports, ctx, {
      name: "goals.updateProgress",
      args: { goal: "clientes", value: 3 },
    });
    const [a] = surfacesFromOutcome("goals.create", created, { key: "call-1", locale: "es" });
    const [b] = surfacesFromOutcome("goals.updateProgress", updated, {
      key: "call-2",
      locale: "es",
    });
    expect(a!.type).toBe("goal");
    expect(a!.id).toBe(b!.id);
    expect((b!.payload as { goal: { value: number; percent: number } }).goal).toMatchObject({
      value: 3,
      percent: 25,
    });
    const list1 = await executeToolCall(ports, ctx, {
      name: "goals.list",
      args: { period: "this_year" },
    });
    const list2 = await executeToolCall(ports, ctx, {
      name: "goals.list",
      args: { period: "this_year" },
    });
    const [o1] = surfacesFromOutcome("goals.list", list1, { key: "x", locale: "es" });
    const [o2] = surfacesFromOutcome("goals.list", list2, { key: "y", locale: "es" });
    expect(o1!.type).toBe("goals_overview");
    expect(o1!.id).toBe(o2!.id);
  });

  it("a habit check-in or a task completion refreshes visible goal Surfaces in place", () => {
    const surface = {
      type: "goal",
      ref: { resource: "goal", id: "g1" },
      query: { tool: "goals.getProgress", args: { goal: "g1" } },
    } as unknown as Surface;
    const checkIn = changeOf(
      "habits.checkIn",
      { name: "checkIn", kind: "write" },
      { status: "succeeded", target: { type: "habit", id: "h1" } },
    );
    const task = changeOf(
      "tasks.complete",
      { name: "complete", kind: "write" },
      { status: "succeeded", target: { type: "task", id: "t1" } },
    );
    expect(decide(surface, checkIn!)).toBe("update");
    expect(decide(surface, task!)).toBe("update");
    const deleted = changeOf(
      "goals.delete",
      { name: "delete", kind: "destructive" },
      { status: "succeeded", target: { type: "goal", id: "g1" } },
    );
    expect(decide(surface, deleted!)).toBe("dismiss");
  });

  it("routes Vision questions and goal Surfaces to the goal tools", () => {
    const tools = [{ name: "goals.getVision" }, { name: "tasks.list" }] as unknown as Parameters<
      typeof selectTools
    >[0];
    expect(selectTools(tools, { message: "¿Cómo vengo con Firbot Solutions?" }).groups).toContain(
      "goals",
    );
    expect(selectTools(tools, { message: "hola", surfaceTypes: ["vision"] }).groups).toContain(
      "goals",
    );
  });
});

// ── Morning Brief ────────────────────────────────────────────────────────────

describe("Morning Brief goals", () => {
  it("mentions goals at risk, due soon, reached or just completed — never every goal", () => {
    const today = "2026-10-13";
    const make = (g: Goal) => ({ ...snap(g, NO_LINKS, today) });
    const brief = assembleBrief({
      now: new Date("2026-10-13T10:30:00Z"),
      timezone: "America/Argentina/Buenos_Aires",
      goals: [
        make(goal({ id: "1", title: "Atrasado", targetDate: "2026-10-01" })),
        make(goal({ id: "2", title: "Vence pronto", targetDate: "2026-10-20", currentValue: 11 })),
        make(
          goal({
            id: "3",
            title: "Logrado ayer",
            status: "completed",
            completedAt: "2026-10-12T20:00:00Z",
          }),
        ),
        make(goal({ id: "4", title: "Tranquilo", targetDate: "2027-06-30", currentValue: 7 })),
      ],
      warnings: [],
    });
    expect(brief.goals?.map((g) => [g.title, g.why])).toEqual([
      ["Atrasado", "at_risk"],
      ["Vence pronto", "due_soon"],
      ["Logrado ayer", "completed"],
    ]);
  });
});

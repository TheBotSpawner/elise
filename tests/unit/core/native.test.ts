import { describe, expect, it } from "vitest";

import { executeToolCall } from "@/core/agents/executor";
import type { ProviderFactory } from "@/core/agents/tools";
import { assembleBrief } from "@/core/briefs/morning-brief";
import { goalProgress, type Goal, type GoalsProvider } from "@/core/capabilities/goals";
import {
  habitProgress,
  weekStart,
  type Habit,
  type HabitEntry,
  type HabitsProvider,
} from "@/core/capabilities/habits";
import {
  matchItems,
  type ListItem,
  type ListsProvider,
  type NativeList,
} from "@/core/capabilities/lists";
import { noteKnowledgePlan } from "@/core/capabilities/notes";
import { buildPreview, suggestMapping } from "@/core/native/import";

import { binding, makeCtx, makePorts, NATIVE_BINDING } from "../../fixtures/core-fakes";

const habit = (over: Partial<Habit> = {}): Habit => ({
  id: "h1",
  name: "Run",
  description: null,
  frequency: "weekly",
  target: 3,
  unit: null,
  preferredDays: [],
  active: true,
  startDate: "2026-01-01",
  createdAt: "",
  ...over,
});
const entry = (date: string, value = 1, over: Partial<HabitEntry> = {}): HabitEntry => ({
  id: date,
  habitId: "h1",
  date,
  value,
  status: "done",
  notes: null,
  source: "user_ui",
  ...over,
});

// 2026-09-30 is a Wednesday; its ISO week starts Monday 2026-09-28.
const WED = "2026-09-30";

describe("habit progress (deterministic)", () => {
  it("weekly sessions: done / target, remaining, Mon–Sun days", () => {
    const p = habitProgress(habit(), [entry("2026-09-28"), entry(WED)], WED);
    expect(weekStart(WED)).toBe("2026-09-28");
    expect(p.week).toMatchObject({ done: 2, goal: 3, remaining: 1, atRisk: false });
    expect(p.week.days.map((d) => d.met)).toEqual([true, false, true, false, false, false, false]);
    expect(p.today).toMatchObject({ met: true });
  });

  it("flags a weekly target that can no longer be reached", () => {
    const p = habitProgress(habit({ target: 5 }), [], "2026-10-02"); // Friday, 0 done
    expect(p.week).toMatchObject({ done: 0, remaining: 5, atRisk: true });
  });

  it("quantitative daily habits: a day counts only when the amount is reached", () => {
    const water = habit({ frequency: "daily", target: 2, unit: "liters" });
    const p = habitProgress(water, [entry("2026-09-28", 2), entry("2026-09-29", 1.5)], WED);
    expect(p.week.days.slice(0, 3).map((d) => [d.value, d.met])).toEqual([
      [2, true],
      [1.5, false],
      [0, false],
    ]);
    expect(p.week).toMatchObject({ done: 1, goal: 7 });
  });

  it("weekly quantities sum values", () => {
    const km = habit({ target: 20, unit: "km" });
    expect(
      habitProgress(km, [entry("2026-09-28", 8), entry("2026-09-29", 5)], WED).week,
    ).toMatchObject({ done: 13, goal: 20, remaining: 7 });
  });

  it("specific days: only scheduled days count", () => {
    const tueSat = habit({ frequency: "specific_days", target: 1, preferredDays: [2, 6] });
    const p = habitProgress(tueSat, [entry("2026-09-29"), entry("2026-09-28")], WED);
    expect(p.week).toMatchObject({ done: 1, goal: 2 });
  });

  it("daily streak: today pending doesn't break it; a missed day does", () => {
    const read = habit({ frequency: "daily", target: 1 });
    const p = habitProgress(
      read,
      [entry("2026-09-27"), entry("2026-09-28"), entry("2026-09-29")],
      WED,
    );
    expect(p.streak).toEqual({ count: 3, unit: "days" });
    const broken = habitProgress(read, [entry("2026-09-26"), entry("2026-09-28")], WED);
    expect(broken.streak.count).toBe(0);
  });

  it("weekly streak counts completed weeks", () => {
    const weeks = [
      "2026-09-14",
      "2026-09-15",
      "2026-09-16",
      "2026-09-21",
      "2026-09-22",
      "2026-09-23",
    ].map((d) => entry(d));
    expect(habitProgress(habit(), weeks, WED).streak).toEqual({ count: 2, unit: "weeks" });
  });

  it("skipped days never count", () => {
    expect(habitProgress(habit(), [entry(WED, 1, { status: "skipped" })], WED).week.done).toBe(0);
  });
});

const goal = (over: Partial<Goal> = {}): Goal => ({
  id: "g1",
  title: "Half marathon under 1:45",
  description: null,
  status: "active",
  targetDate: null,
  progressType: "numeric",
  progressMode: "manual",
  startValue: 120,
  currentValue: 110,
  targetValue: 105,
  direction: "decrease",
  metric: "minutes",
  parentGoalId: null,
  completedAt: null,
  links: [],
  createdAt: "",
  updatedAt: "",
  ...over,
});
const none = { tasks: { total: 0, completed: 0, open: [] }, habits: [] };

describe("goal progress", () => {
  it("numeric toward a lower target", () => {
    expect(goalProgress(goal(), none)).toMatchObject({ percent: 67, basis: "manual" });
  });

  it("never invents a number for unmeasurable goals", () => {
    expect(goalProgress(goal({ progressType: "binary" }), none).percent).toBe(0);
    expect(goalProgress(goal({ currentValue: null }), none)).toMatchObject({
      percent: null,
      basis: "not measurable yet",
    });
    expect(goalProgress(goal({ status: "completed" }), none).percent).toBe(100);
  });

  it("linked and hybrid progress come from tasks and habits, with the basis stated", () => {
    const status = {
      tasks: { total: 4, completed: 1, open: ["a", "b", "c"] },
      habits: [{ name: "Run", done: 2, goal: 3 }],
    };
    expect(goalProgress(goal({ progressMode: "linked" }), status)).toMatchObject({
      percent: 46,
      linked: 46,
    });
    expect(goalProgress(goal({ progressMode: "hybrid" }), status).percent).toBe(57);
    expect(goalProgress(goal({ progressMode: "linked" }), none)).toMatchObject({
      percent: null,
      basis: "nothing linked yet",
    });
  });
});

describe("notes ↔ knowledge plan", () => {
  it("indexes, moves, removes — one editable note, never a copy", () => {
    expect(noteKnowledgePlan(null, { spaceId: "s1" }, false)).toBe("reindex");
    expect(noteKnowledgePlan("s1", { spaceId: "s1" }, false)).toBe("reindex");
    expect(noteKnowledgePlan("s1", { spaceId: "s2" }, false)).toBe("move");
    expect(noteKnowledgePlan("s1", { spaceId: null }, false)).toBe("remove");
    expect(noteKnowledgePlan("s1", { spaceId: "s1" }, true)).toBe("remove");
    expect(noteKnowledgePlan(null, { spaceId: null }, false)).toBe("none");
  });
});

describe("import", () => {
  const csv =
    "Habit Name,Weekly Target,Unit,Días\nRun,3,,\nWater,2,liters,\n,4,,\nPiano,1,,mar sab\nYoga,abc,,";

  it("proposes a mapping from headers", () => {
    expect(suggestMapping(["Habit Name", "Weekly Target", "Unit"], "habits")).toEqual({
      name: "Habit Name",
      target: "Weekly Target",
      unit: "Unit",
    });
  });

  it("validates each row and keeps going past bad ones", () => {
    const p = buildPreview(csv, "habits", null);
    expect(p.mapping.days).toBe("Días");
    expect(p.valid.map((v) => v.record)).toMatchObject([
      { name: "Run", frequency: "weekly", target: 3 },
      { name: "Water", unit: "liters", target: 2 },
      { name: "Piano", frequency: "specific_days", preferredDays: [2, 6] },
    ]);
    expect(p.invalid.map((i) => i.row)).toEqual([4, 6]);
    expect(p.invalid[1]!.errors[0]).toContain("not a positive number");
  });

  it("refuses to import without the required column", () => {
    const p = buildPreview("Foo,Bar\n1,2", "lists", null);
    expect(p.valid).toHaveLength(0);
    expect(p.invalid[0]!.errors[0]).toContain("item");
  });
});

describe("Morning Brief with habits and goals", () => {
  it("includes habits at risk or due today and a few active goals", () => {
    const run = habitProgress(habit(), [entry("2026-09-28")], WED);
    const gym = habitProgress(
      habit({ id: "h2", name: "Gym", target: 1 }),
      [entry("2026-09-28", 1, { habitId: "h2" })],
      WED,
    );
    const brief = assembleBrief({
      now: new Date("2026-09-30T10:30:00Z"),
      timezone: "America/Argentina/Buenos_Aires",
      habits: [run, gym],
      goals: [
        {
          goal: goal({ title: "Launch ELISE MVP", progressType: "binary" }),
          progress: goalProgress(goal({ progressType: "binary" }), none),
          openTasks: 3,
        },
      ],
      warnings: [],
    });
    expect(brief.habits).toEqual([
      expect.objectContaining({ name: "Run", week: "1/3", dueToday: true }),
    ]);
    expect(brief.goals).toEqual([
      expect.objectContaining({ title: "Launch ELISE MVP", openTasks: 3 }),
    ]);
  });
});

// ── Tools through the executor, over in-memory native providers ──────────────

class MemoryHabits implements HabitsProvider {
  habits: Habit[] = [];
  stored: HabitEntry[] = [];
  async list() {
    return this.habits.filter((h) => h.active);
  }
  async find(ref: string) {
    return this.habits.filter(
      (h) => h.id === ref || h.name.toLowerCase().includes(ref.toLowerCase()),
    );
  }
  async create(h: Parameters<HabitsProvider["create"]>[0]) {
    const created = habit({
      ...h,
      id: crypto.randomUUID(),
      unit: h.unit ?? null,
      preferredDays: h.preferredDays ?? [],
      description: h.description ?? null,
    });
    this.habits.push(created);
    return created;
  }
  async update(id: string, p: Partial<Habit>) {
    const h = this.habits.find((x) => x.id === id)!;
    Object.assign(h, Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined)));
    return h;
  }
  async archive(id: string) {
    return this.update(id, { active: false });
  }
  async entries(ids: string[]) {
    return this.stored.filter((e) => ids.includes(e.habitId));
  }
  async checkIn(
    habitId: string,
    e: { date: string; value: number; mode: "add" | "set"; status: "done" | "skipped" },
  ) {
    const existing = this.stored.find((x) => x.habitId === habitId && x.date === e.date);
    if (existing) {
      existing.value = e.mode === "add" ? existing.value + e.value : e.value;
      existing.status = e.status;
      return existing;
    }
    const created = entry(e.date, e.value, { habitId, status: e.status, id: crypto.randomUUID() });
    this.stored.push(created);
    return created;
  }
  async removeEntry(habitId: string, date: string) {
    this.stored = this.stored.filter((x) => !(x.habitId === habitId && x.date === date));
  }
}
class MemoryLists implements ListsProvider {
  lists: NativeList[] = [];
  async list() {
    return this.lists.map((l) => ({
      ...l,
      total: l.items.length,
      open: l.items.filter((i) => !i.checked).length,
    }));
  }
  async find(ref: string) {
    return this.lists.filter(
      (l) => l.id === ref || l.name.toLowerCase().includes(ref.toLowerCase()),
    );
  }
  async get(id: string) {
    return this.lists.find((l) => l.id === id) ?? null;
  }
  async create(l: { name: string; items?: string[] }) {
    const list: NativeList = {
      id: crypto.randomUUID(),
      name: l.name,
      description: null,
      items: [],
      updatedAt: "",
    };
    this.lists.push(list);
    if (l.items) await this.addItems(list.id, l.items);
    return list;
  }
  async rename(id: string, name: string) {
    const l = (await this.get(id))!;
    l.name = name;
    return l;
  }
  async archive(id: string) {
    return (await this.get(id))!;
  }
  async addItems(listId: string, items: string[]) {
    const list = (await this.get(listId))!;
    const added = items.map((content, i): ListItem => ({
      id: crypto.randomUUID(),
      listId,
      content,
      checked: false,
      position: list.items.length + i,
      notes: null,
    }));
    list.items.push(...added);
    return added;
  }
  async updateItem(itemId: string, p: { checked?: boolean; content?: string }) {
    const item = this.lists.flatMap((l) => l.items).find((i) => i.id === itemId)!;
    Object.assign(item, Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined)));
    return item;
  }
  async removeItem(itemId: string) {
    const list = this.lists.find((l) => l.items.some((i) => i.id === itemId))!;
    const item = list.items.find((i) => i.id === itemId)!;
    list.items = list.items.filter((i) => i.id !== itemId);
    return item;
  }
  async reorder(listId: string) {
    return (await this.get(listId))!;
  }
}

function nativePorts() {
  const habits = new MemoryHabits();
  const lists = new MemoryLists();
  const goalsFake: Partial<GoalsProvider> = {};
  const bindings = ["habits", "lists", "goals"].map((capability) =>
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
    get: ((c: string) =>
      c === "habits" ? habits : c === "lists" ? lists : goalsFake) as ProviderFactory["get"],
  };
  return { ports, habits, lists };
}

describe("native tools", () => {
  it("creates a habit from chat and checks in on the user's local date, without duplicates", async () => {
    const { ports, habits } = nativePorts();
    // 02:00 UTC on Wednesday is still Tuesday 23:00 in Buenos Aires.
    const ctx = makeCtx({ now: new Date("2026-09-30T02:00:00Z") });
    await executeToolCall(ports, ctx, {
      name: "habits.create",
      args: { name: "Run", frequency: "weekly", target: 3 },
    });
    const first = await executeToolCall(ports, ctx, {
      name: "habits.checkIn",
      args: { habit: "run" },
    });
    await executeToolCall(ports, ctx, { name: "habits.checkIn", args: { habit: "run" } });
    const stored = habits.stored;
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ date: "2026-09-29", value: 1 });
    expect(first).toMatchObject({
      status: "succeeded",
      output: { habits: [{ thisWeek: "1 / 3", remainingThisWeek: 2 }] },
    });
  });

  it("measured check-ins add up, and 'set' corrects the day", async () => {
    const { ports } = nativePorts();
    const ctx = makeCtx();
    await executeToolCall(ports, ctx, {
      name: "habits.create",
      args: { name: "Water", frequency: "daily", target: 2, unit: "liters" },
    });
    await executeToolCall(ports, ctx, {
      name: "habits.checkIn",
      args: { habit: "water", value: 1.5 },
    });
    const add = await executeToolCall(ports, ctx, {
      name: "habits.checkIn",
      args: { habit: "water", value: 0.5 },
    });
    expect(add).toMatchObject({ output: { habits: [{ today: { value: 2, met: true } }] } });
    const set = await executeToolCall(ports, ctx, {
      name: "habits.checkIn",
      args: { habit: "water", value: 1, mode: "set" },
    });
    expect(set).toMatchObject({ output: { habits: [{ today: { value: 1, met: false } }] } });
  });

  it("an ambiguous name asks instead of guessing", async () => {
    const { ports } = nativePorts();
    const ctx = makeCtx();
    await executeToolCall(ports, ctx, {
      name: "habits.create",
      args: { name: "Run short", frequency: "daily" },
    });
    await executeToolCall(ports, ctx, {
      name: "habits.create",
      args: { name: "Run long", frequency: "weekly", target: 1 },
    });
    const out = await executeToolCall(ports, ctx, {
      name: "habits.checkIn",
      args: { habit: "run" },
    });
    expect(out).toMatchObject({ status: "failed", error: { code: "VALIDATION_ERROR" } });
  });

  it("lists: create with items, check one, and read what's still missing", async () => {
    const { ports } = nativePorts();
    const ctx = makeCtx();
    await executeToolCall(ports, ctx, {
      name: "lists.create",
      args: { name: "Japan packing", items: ["passport", "charger", "headphones"] },
    });
    await executeToolCall(ports, ctx, {
      name: "lists.checkItem",
      args: { list: "japan", item: "Passport" },
    });
    const out = await executeToolCall(ports, ctx, { name: "lists.get", args: { list: "japan" } });
    expect(out).toMatchObject({
      output: { list: { open: ["charger", "headphones"], checked: ["passport"] } },
    });
  });

  it("archiving asks for approval when ELISE proposes it, not for check-ins", async () => {
    const { ports } = nativePorts();
    const ctx = makeCtx();
    await executeToolCall(ports, ctx, {
      name: "habits.create",
      args: { name: "Gym", frequency: "weekly", target: 4 },
    });
    const archive = await executeToolCall(ports, ctx, {
      name: "habits.archive",
      args: { habit: "gym" },
    });
    expect(archive.status).toBe("approval_required");
    const ui = await executeToolCall(ports, makeCtx({ origin: "user_ui" }), {
      name: "habits.archive",
      args: { habit: "gym" },
    });
    expect(ui.status).toBe("succeeded");
  });

  it("matches list items by text", () => {
    const list: NativeList = {
      id: "l",
      name: "x",
      description: null,
      updatedAt: "",
      items: [{ id: "i", listId: "l", content: "Café", checked: false, position: 1, notes: null }],
    };
    expect(matchItems(list, "cafe")).toHaveLength(1);
  });
});

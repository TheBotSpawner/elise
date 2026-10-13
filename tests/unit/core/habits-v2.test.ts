import { describe, expect, it } from "vitest";

import {
  checkInDate,
  habitProgress,
  isHabitIcon,
  type Habit,
  type HabitEntry,
} from "@/core/capabilities/habits";
import {
  buildHabitStatsReport,
  dailyIntensity,
  entriesWindow,
  granularityFor,
  habitRange,
  habitStats,
  habitsSummary,
  habitsTrend,
  longestStreak,
  monthlyRates,
  previousRange,
  rateDelta,
  shiftHabitRange,
  suggestHabitIcon,
  weekdayMisses,
} from "@/core/habits/analytics";
import { todayIn } from "@/core/time";
import { surfacesFromOutcome } from "@/core/workspace/from-results";
import { habitStatsVisuals } from "@/core/workspace/visualization";

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
  createdAt: "",
  icon: null,
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

// 2026-10-12 is a Monday. Week: 12–18 Oct.
const MON = "2026-10-12";
const SAT = "2026-10-17";

describe("Habits analytics (ADR-053)", () => {
  it("ranges: week, month, year, custom, ‹ › and the previous period", () => {
    expect(habitRange("week", "2026-10-15")).toEqual({ view: "week", from: MON, to: "2026-10-18" });
    expect(habitRange("month", "2026-10-15")).toMatchObject({
      from: "2026-10-01",
      to: "2026-10-31",
    });
    expect(habitRange("year", "2026-10-15")).toMatchObject({
      from: "2026-01-01",
      to: "2026-12-31",
    });
    expect(habitRange("custom", MON, { from: "2026-09-01", to: MON })).toMatchObject({
      view: "custom",
      from: "2026-09-01",
    });
    expect(shiftHabitRange(habitRange("week", MON), -1)).toMatchObject({ from: "2026-10-05" });
    expect(shiftHabitRange(habitRange("month", MON), 1)).toMatchObject({
      from: "2026-11-01",
      to: "2026-11-30",
    });
    expect(previousRange(habitRange("year", MON))).toMatchObject({ from: "2025-01-01" });
    expect(granularityFor(habitRange("week", MON))).toBe("day");
    expect(granularityFor(habitRange("month", MON))).toBe("week");
    expect(granularityFor(habitRange("year", MON))).toBe("month");
    // Only the range, the previous one and 26 weeks for streaks: never the full history.
    expect(entriesWindow(habitRange("week", MON), MON)).toEqual({
      from: "2026-04-13",
      to: "2026-10-18",
    });
  });

  it("binary daily: progress over the period, completion over the days so far", () => {
    const h = habit({ frequency: "daily", target: 1 });
    const s = habitStats(
      h,
      [done("2026-10-12"), done("2026-10-13")],
      habitRange("week", MON),
      "2026-10-14",
    );
    expect(s).toMatchObject({ done: 2, goal: 7, expectedSoFar: 3 });
    expect(s.progress).toBeCloseTo(2 / 7);
    expect(s.rate).toBeCloseTo(2 / 3);
    expect(s.days.map((d) => d.state)).toEqual([
      "done",
      "done",
      "pending",
      "future",
      "future",
      "future",
      "future",
    ]);
  });

  it("quantitative daily: partial days, totals, average and target attainment", () => {
    const h = habit({ frequency: "daily", target: 8, unit: "vasos" });
    const s = habitStats(
      h,
      [done("2026-10-12", 8), done("2026-10-13", 6)],
      habitRange("week", MON),
      "2026-10-14",
    );
    expect(s.done).toBe(1);
    expect(s.days[1]!.state).toBe("partial");
    expect(s.quantity).toEqual({ total: 14, activeDays: 2, perActiveDay: 7 });
    // (1 + 0.75 + 0) / 3 days so far.
    expect(s.attainment).toBeCloseTo(0.58, 2);
  });

  it("weekly frequency: target per week, capped per week, prorated partial weeks", () => {
    const h = habit();
    const week = habitStats(h, [done(MON), done("2026-10-14")], habitRange("week", MON), SAT);
    expect(week).toMatchObject({ done: 2, goal: 3 });
    expect(week.progress).toBeCloseTo(2 / 3);
    // October: 4 sessions in one week can't hide an empty week.
    const month = habitStats(
      h,
      ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08"].map((d) => done(d)),
      habitRange("month", MON),
      "2026-10-31",
    );
    // 3 × 31/7 = 13.3 sessions, shown as 13 (the rate keeps the exact share).
    expect(month.goal).toBe(13);
    expect(month.rate).toBeCloseTo(3 / ((3 * 31) / 7), 2);
  });

  it("specific weekdays: unscheduled days are rest, never failures", () => {
    const h = habit({ frequency: "specific_days", target: 1, preferredDays: [1, 3, 5] });
    const s = habitStats(h, [done(MON)], habitRange("week", MON), "2026-10-18");
    expect(s.goal).toBe(3);
    expect(s.days.filter((d) => d.state === "rest")).toHaveLength(4);
    expect(s.days.filter((d) => d.state === "missed").map((d) => d.date)).toEqual([
      "2026-10-14",
      "2026-10-16",
    ]);
  });

  it("history edits count: a backfilled past day changes progress and streak", () => {
    const h = habit({ frequency: "daily", target: 1 });
    const before = habitProgress(h, [done("2026-10-11")], MON).streak.count;
    const after = habitProgress(h, [done("2026-10-10"), done("2026-10-11")], MON).streak.count;
    expect([before, after]).toEqual([1, 2]);
  });

  it("streaks respect the schedule; longest streak over the whole history", () => {
    const mwf = habit({ frequency: "specific_days", target: 1, preferredDays: [1, 3, 5] });
    // Mon, Wed, Fri, Mon met: 4 in a row (Tue/Thu/weekend don't break it).
    const entries = ["2026-10-05", "2026-10-07", "2026-10-09", MON].map((d) => done(d));
    expect(habitProgress(mwf, entries, MON).streak).toEqual({ count: 4, unit: "days" });
    const weekly = habit();
    const weeks = [
      ...["2026-09-07", "2026-09-08", "2026-09-09"],
      ...["2026-09-14", "2026-09-15", "2026-09-16"],
      ...["2026-09-28", "2026-09-29", "2026-09-30"],
    ].map((d) => done(d));
    expect(longestStreak(weekly, weeks, MON)).toEqual({ count: 2, unit: "weeks" });
    // The week of 5 Oct was empty: the current streak is broken.
    expect(habitProgress(weekly, weeks, MON).streak).toEqual({ count: 0, unit: "weeks" });
  });

  it("risk: Monday 0/3 is fine, Friday 0/3 is at risk, Saturday 0/3 can't be met", () => {
    const h = habit();
    expect(habitProgress(h, [], MON).week).toMatchObject({ atRisk: false, unreachable: false });
    expect(habitProgress(h, [], "2026-10-16").week).toMatchObject({
      atRisk: true,
      unreachable: false,
    });
    expect(habitProgress(h, [], SAT).week).toMatchObject({ atRisk: true, unreachable: true });
    expect(habitProgress(h, [done(MON), done("2026-10-13")], SAT).week.atRisk).toBe(false);
  });

  it("summary, comparison with the previous period, trend, weekdays and heatmap", () => {
    const a = habit({ id: "a", frequency: "daily", target: 1 });
    const b = habit({ id: "b", frequency: "daily", target: 1, active: false });
    const entries = [done("2026-10-05", 1, "a"), done(MON, 1, "a"), done("2026-10-13", 1, "a")];
    const week = habitRange("week", MON);
    const s = habitsSummary([a, b], entries, week, "2026-10-14", ["a"]);
    // Paused habits are left out.
    expect(s).toMatchObject({ active: 1, atRisk: ["a"] });
    expect(s.rate).toBeCloseTo(2 / 3, 2);
    const prev = habitsSummary([a], entries, previousRange(week), "2026-10-14");
    expect(prev.rate).toBeCloseTo(1 / 7, 2);
    // 0.67 − 0.14 (rates are rounded to two decimals).
    expect(rateDelta(s.rate, prev.rate)).toBe(53);
    const trend = habitsTrend([a], entries, week, "2026-10-14");
    expect(trend.points.map((p) => p.rate)).toEqual([1, 1, 0, null, null, null, null]);
    const misses = weekdayMisses([a], entries, week, "2026-10-14");
    expect(misses.find((m) => m.weekday === 1)).toEqual({ weekday: 1, expected: 1, missed: 0 });
    expect(dailyIntensity([a], entries, week, "2026-10-14").slice(0, 3)).toEqual([
      { date: MON, value: 1 },
      { date: "2026-10-13", value: 1 },
      { date: "2026-10-14", value: 0 },
    ]);
    const months = monthlyRates([a], entries, "2026", "2026-10-14");
    expect(months[11]!.rate).toBeNull();
  });

  it("timezone: the local day decides (23:30 in Buenos Aires is still that day)", () => {
    const now = new Date("2026-10-13T02:30:00Z");
    expect(todayIn("America/Argentina/Buenos_Aires", now)).toBe("2026-10-12");
    expect(checkInDate("2026-10-12", { weekday: 4 })).toBe("2026-10-08");
  });

  it("icons: one emoji only (no text, no markup); suggestions from the name", () => {
    expect(isHabitIcon("🏋️")).toBe(true);
    expect(isHabitIcon("📚")).toBe(true);
    expect(isHabitIcon("ab")).toBe(false);
    expect(isHabitIcon("<svg/>")).toBe(false);
    expect(isHabitIcon("📚📚")).toBe(false);
    expect(suggestHabitIcon("Leer 30 minutos")).toBe("📚");
    expect(suggestHabitIcon("Workout")).toBe("🏋️");
    expect(suggestHabitIcon("Algo raro")).toBeNull();
  });

  it("stats report → Canvas: stable Surface per habit and range, standard charts", () => {
    const h = habit({ icon: "🏋️" });
    const entries = [done("2026-10-05"), done("2026-10-06"), done("2026-10-07"), done(MON)];
    const report = buildHabitStatsReport([h], entries, habitRange("week", MON), MON, {
      fullHistory: true,
    });
    expect(report.habits[0]).toMatchObject({ done: 1, goal: 3, longest: { count: 1 } });
    const visuals = habitStatsVisuals(report, MON, "es");
    // One elapsed day: no trend line to draw yet.
    expect(visuals.map((v) => v.role)).toEqual(["kpi", "habits"]);
    const surfaces = (r: typeof report) =>
      surfacesFromOutcome(
        "habits.getStats",
        { status: "succeeded", display: { kind: "habit_stats", report: r } },
        { key: "call-1", locale: "es" },
      ).map((d) => d.id);
    const first = surfaces(report);
    // A refreshed read (after a check-in) maps onto the same Surfaces.
    const refreshed = buildHabitStatsReport(
      [h],
      [...entries, done("2026-10-13")],
      report.range,
      "2026-10-13",
    );
    expect(surfaces(refreshed)).toEqual(first);
    // Another range is another Surface.
    const month = buildHabitStatsReport([h], entries, habitRange("month", MON), MON);
    expect(surfaces(month)[0]).not.toBe(first[0]);
  });
});

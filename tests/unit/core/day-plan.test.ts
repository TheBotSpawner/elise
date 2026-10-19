import { describe, expect, it } from "vitest";

import type { CalendarEvent } from "@/core/capabilities/calendar";
import { blocksFromText, planDay, targetDay } from "@/core/planning/day-plan";

/**
 * A day's plan (regression of a real conversation on Monday 19 Oct 2026): checked against
 * itself and the calendar, never the model's arithmetic; a plan said in words still gets its
 * visual; the latest correction of the day wins.
 */
const TZ = "America/Argentina/Buenos_Aires";
const MONDAY = "2026-10-19";
const TUESDAY = "2026-10-20";

const event = (over: Partial<CalendarEvent>): CalendarEvent => ({
  id: "ev1",
  calendarId: "primary",
  calendarName: "Personal",
  title: "Clase",
  description: null,
  location: null,
  start: "2026-10-20T17:15:00.000Z", // 14:15 in Buenos Aires
  end: "2026-10-20T21:00:00.000Z", // 18:00
  allDay: false,
  attendees: [],
  status: "confirmed",
  url: null,
  provenance: {
    providerKey: "google",
    connectionId: "c1",
    externalId: "e1",
    source: "Personal",
  } as CalendarEvent["provenance"],
  ...over,
});

describe("which day a request is about", () => {
  it("“mañana” from Monday is Tuesday; the latest correction wins", () => {
    expect(targetDay("Organicemos mañana: me levanto a las ocho", MONDAY)).toBe(TUESDAY);
    expect(targetDay("¿Qué tengo mañana? No, perdón, hoy lunes", MONDAY)).toBe(MONDAY);
    expect(targetDay("hoy no, mejor mañana", MONDAY)).toBe(TUESDAY);
  });

  it("“por la mañana” is a morning, not tomorrow", () => {
    expect(targetDay("hoy trabajo por la mañana", MONDAY)).toBe(MONDAY);
    expect(targetDay("trabajo por la mañana y entreno de noche", MONDAY)).toBeNull();
  });

  it("weekdays and “pasado mañana” are relative to the real date", () => {
    expect(targetDay("el martes", MONDAY)).toBe(TUESDAY);
    expect(targetDay("el lunes", MONDAY)).toBe(MONDAY);
    expect(targetDay("pasado mañana", MONDAY)).toBe("2026-10-21");
  });
});

describe("a day's plan", () => {
  const blocks = [
    { start: "08:00", end: "08:30", label: "Levantarse y desayunar", given: true },
    { start: "09:00", end: "12:30", label: "Trabajo Proyecto A", category: "work" as const },
    { start: "14:15", end: "18:00", label: "Clase", category: "class" as const, given: true },
    { start: "20:00", end: "21:30", label: "Gimnasio", category: "exercise" as const },
  ];

  it("orders blocks, finds gaps, and keeps who chose each time", () => {
    const r = planDay({ date: TUESDAY, timezone: TZ, blocks, events: [] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.blocks.map((b) => [b.start, b.end, b.origin, b.state])).toEqual([
      ["08:00", "08:30", "user", "proposed"],
      ["09:00", "12:30", "suggested", "proposed"],
      ["14:15", "18:00", "user", "proposed"],
      ["20:00", "21:30", "suggested", "proposed"],
    ]);
    expect(r.plan.blocks[2]!.minutes).toBe(225);
    expect(r.plan.gaps.map((g) => `${g.start}-${g.end}`)).toEqual([
      "08:30-09:00",
      "12:30-14:15",
      "18:00-20:00",
    ]);
  });

  it("an inverted block is rejected, never silently accepted", () => {
    const r = planDay({
      date: TUESDAY,
      timezone: TZ,
      blocks: [{ start: "18:00", end: "14:15", label: "Clase" }],
      events: [],
    });
    expect(r).toMatchObject({ ok: false });
  });

  it("overlaps are flagged on both blocks", () => {
    const r = planDay({
      date: TUESDAY,
      timezone: TZ,
      blocks: [
        { start: "09:00", end: "13:00", label: "Trabajo" },
        { start: "12:00", end: "13:00", label: "Almuerzo" },
      ],
      events: [],
    });
    if (!r.ok) throw new Error(r.reason);
    expect(r.plan.blocks.every((b) => b.conflicts.length === 1)).toBe(true);
    expect(r.plan.warnings).toContainEqual({ kind: "overlap", a: "b1", b: "b2" });
  });

  it("a block the calendar holds is saved; other events join as they are", () => {
    const r = planDay({
      date: TUESDAY,
      timezone: TZ,
      blocks,
      events: [
        event({}),
        event({
          id: "ev2",
          title: "Dentista",
          start: "2026-10-20T13:00:00.000Z",
          end: "2026-10-20T14:00:00.000Z",
        }),
        event({ id: "ev3", title: "Feriado", allDay: true, start: TUESDAY, end: "2026-10-21" }),
      ],
    });
    if (!r.ok) throw new Error(r.reason);
    const clase = r.plan.blocks.find((b) => b.label === "Clase")!;
    expect(clase).toMatchObject({ state: "saved", eventId: "ev1", origin: "user" });
    expect(r.plan.blocks.filter((b) => b.label === "Clase")).toHaveLength(1); // never twice
    expect(r.plan.blocks.find((b) => b.label === "Dentista")).toMatchObject({
      origin: "calendar",
      start: "10:00",
      end: "11:00",
      conflicts: ["b2"], // inside the work block
    });
    expect(r.plan.blocks.some((b) => b.label === "Feriado")).toBe(false);
  });

  it("a day the clock changes: real durations and skipped times are flagged", () => {
    // New York springs forward on 8 Mar 2026: 02:00–03:00 doesn't exist.
    const r = planDay({
      date: "2026-03-08",
      timezone: "America/New_York",
      blocks: [{ start: "01:00", end: "04:00", label: "Turno" }],
      events: [],
    });
    if (!r.ok) throw new Error(r.reason);
    expect(r.plan.blocks[0]!.minutes).toBe(120);
    const late = planDay({
      date: "2026-03-08",
      timezone: "America/New_York",
      blocks: [{ start: "02:30", end: "04:00", label: "Turno" }],
      events: [],
    });
    if (!late.ok) throw new Error(late.reason);
    expect(late.plan.warnings).toContainEqual({ kind: "nonexistent_time", at: "02:30" });
  });

  it("a calendar that couldn't be read is said, not hidden", () => {
    const r = planDay({ date: TUESDAY, timezone: TZ, blocks, events: null });
    if (!r.ok) throw new Error(r.reason);
    expect(r.plan.warnings).toContainEqual({ kind: "calendar_unavailable" });
  });
});

describe("a plan said only in words", () => {
  it("time ranges in a reply become blocks", () => {
    const reply = [
      "Te propongo esto para mañana:",
      "- 08:00–08:30 Levantarse y desayunar",
      "- **09:00 a 12:30**: Trabajo en Proyecto A",
      "- De 14:15 a 18:00, clase de Análisis",
      "- 20:00-21:30 Gimnasio",
    ].join("\n");
    expect(blocksFromText(reply).map((b) => `${b.start}-${b.end} ${b.label}`)).toEqual([
      "08:00-08:30 Levantarse y desayunar",
      "09:00-12:30 Trabajo en Proyecto A",
      "14:15-18:00 clase de Análisis",
      "20:00-21:30 Gimnasio",
    ]);
  });

  it("numbers that aren't times, or fewer than three blocks, aren't a plan", () => {
    expect(blocksFromText("Somos 2-3 personas, de 5 a 6 cuadras.")).toEqual([]);
    expect(blocksFromText("09:00–10:00 Reunión\n11:00–12:00 Llamada")).toEqual([]);
  });
});

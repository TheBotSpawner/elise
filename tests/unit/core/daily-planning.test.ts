import { describe, expect, it } from "vitest";

import { explicitEmail } from "@/core/agents/tool-selection";
import type { ToolRunEnv } from "@/core/agents/tools";
import type { CalendarEvent } from "@/core/capabilities/calendar";
import { planFromReply } from "@/core/planning/day-plan";
import { proposeDayTool } from "@/core/tools/planning";
import { surfacesFromOutcome } from "@/core/workspace/from-results";
import { decide } from "@/core/workspace/lifecycle";
import type { Surface } from "@/core/workspace/model";
import { beforePresenting } from "@/core/workspace/presentation";
import type { SurfacePayloads } from "@/core/workspace/registry";

/**
 * Daily planning as a first-class result (ADR-098), from a real conversation on Monday 19 Oct
 * 2026 (fixtures only — nothing here is product behavior): the plan is a timeline on screen
 * without "mostrámelo", one per day, never written before the user asks, and it shows what the
 * calendar really holds after a save.
 */
const TZ = "America/Argentina/Buenos_Aires";
const MONDAY_NOON = new Date("2026-10-19T15:00:00Z");

const event = (over: Partial<CalendarEvent>): CalendarEvent => ({
  id: "ev-clase",
  calendarId: "primary",
  calendarName: "Personal",
  title: "Clase",
  description: null,
  location: null,
  start: "2026-10-20T17:15:00.000Z",
  end: "2026-10-20T21:00:00.000Z",
  allDay: false,
  attendees: [],
  status: "confirmed",
  url: null,
  provenance: {
    providerKey: "google",
    connectionId: "c1",
    externalId: "e1",
    source: "Personal",
  },
  ...over,
});

function env(opts: { events?: CalendarEvent[] | "fail"; shown?: Surface[] } = {}) {
  const calls: { name: string; args: unknown }[] = [];
  const e = {
    ctx: {
      timezone: TZ,
      now: MONDAY_NOON,
      locale: "es",
      workspace: {
        state: () => ({ surfaces: opts.shown ?? [] }),
        apply: () => 0,
        activity: () => {},
      },
    },
    invoke: async (name: string, args: unknown) => {
      calls.push({ name, args });
      if (opts.events === "fail")
        return { status: "failed", error: { code: "AUTH_EXPIRED", message: "" } };
      return {
        status: "succeeded",
        display: {
          kind: "event_list",
          events: opts.events ?? [],
          from: "x",
          to: "y",
        },
      };
    },
  } as unknown as ToolRunEnv;
  return { env: e, calls };
}

const tuesday = {
  day: "tomorrow",
  blocks: [
    { start: "08:00", end: "08:30", label: "Levantarse y desayunar", given: true },
    { start: "09:00", end: "12:30", label: "Proyecto A", category: "work", given: false },
    { start: "14:15", end: "18:00", label: "Clase", category: "class", given: true },
    { start: "20:00", end: "21:30", label: "Gimnasio", category: "exercise", given: false },
  ],
};

type Plan = SurfacePayloads["day_plan"];
const planOf = (r: Awaited<ReturnType<typeof proposeDayTool.run>>) =>
  (r.display as { kind: "day_plan"; plan: Plan }).plan;

describe("planning.proposeDay", () => {
  it("“mañana” on Monday is Tuesday 20 Oct, read against that day's calendar only", async () => {
    const { env: e, calls } = env();
    const r = await proposeDayTool.run(tuesday, e);
    expect(planOf(r).date).toBe("2026-10-20");
    expect(calls).toEqual([
      {
        name: "calendar.listEvents",
        args: { from: "2026-10-20", to: "2026-10-21", limit: 50 },
      },
    ]);
    expect(planOf(r).blocks.every((b) => b.state === "proposed")).toBe(true);
    // A read, never a write: the model is told nothing is saved and how saving happens.
    expect(JSON.stringify(r.output)).toMatch(/proposal: nothing is in the calendar/);
  });

  it("an inverted block is refused; a calendar that can't be read is said", async () => {
    await expect(
      proposeDayTool.run(
        {
          day: "tomorrow",
          blocks: [{ start: "18:00", end: "14:15", label: "Clase", given: true }],
        },
        env().env,
      ),
    ).rejects.toThrow(/before it starts/);
    const r = await proposeDayTool.run(tuesday, env({ events: "fail" }).env);
    expect(planOf(r).warnings).toContainEqual({ kind: "calendar_unavailable" });
  });

  it("a change to the same day is its next version, on the same Surface", async () => {
    const first = await proposeDayTool.run(tuesday, env().env);
    const [s1] = surfacesFromOutcome(
      "planning.proposeDay",
      { status: "succeeded", display: first.display! },
      { key: "call-1" },
    );
    const shown = { ...s1!, handle: "S1", turn: 1, createdAt: "", updatedAt: "" } as Surface;
    const moved = {
      ...tuesday,
      blocks: tuesday.blocks.map((b) =>
        b.label === "Gimnasio" ? { ...b, start: "21:00", end: "22:30" } : b,
      ),
    };
    const second = await proposeDayTool.run(moved, env({ shown: [shown] }).env);
    const [s2] = surfacesFromOutcome(
      "planning.proposeDay",
      { status: "succeeded", display: second.display! },
      { key: "call-2" },
    );
    expect(s2!.id).toBe(s1!.id); // one plan per day, whatever the call
    expect(planOf(second).version).toBe(2);
    expect(planOf(second).blocks.find((b) => b.label === "Gimnasio")!.start).toBe("21:00");
  });

  it("after a calendar write the plan re-reads the calendar: the saved block is “saved”", async () => {
    const r = await proposeDayTool.run(tuesday, env().env);
    const [draft] = surfacesFromOutcome(
      "planning.proposeDay",
      { status: "succeeded", display: r.display! },
      { key: "k" },
    );
    const surface = {
      ...draft!,
      handle: "S1",
      turn: 1,
      createdAt: "",
      updatedAt: "",
      query: { tool: "planning.proposeDay", args: tuesday },
    } as Surface;
    // A calendar write (create/update/delete) re-runs the plan's own read (ADR-029).
    expect(
      decide(surface, {
        capability: "calendar",
        resourceType: "calendar_event",
        resourceId: "ev-new",
        operation: "updated",
      }),
    ).toBe("update");
    const after = await proposeDayTool.run(tuesday, env({ events: [event({})] }).env);
    const clase = planOf(after).blocks.filter((b) => b.label === "Clase");
    expect(clase).toHaveLength(1);
    expect(clase[0]).toMatchObject({ state: "saved", eventId: "ev-clase" });
  });
});

describe("a plan said only in words still gets its timeline", () => {
  const reply = [
    "Te propongo esto:",
    "- 08:00–08:30 Levantarse y desayunar",
    "- 09:00–12:30 Trabajo",
    "- 14:15–18:00 Clase",
    "- 20:00–21:30 Gimnasio",
  ].join("\n");

  it("the day comes from the user's words; the latest correction wins", () => {
    expect(
      planFromReply(reply, "Organicemos mañana: me levanto a las ocho", TZ, MONDAY_NOON)?.args.date,
    ).toBe("2026-10-20");
    expect(
      planFromReply(reply, "Armame mañana… no, perdón, hoy lunes", TZ, MONDAY_NOON)?.args.date,
    ).toBe("2026-10-19");
  });

  it("a reply that isn't a day plan presents nothing", () => {
    expect(planFromReply("Tenés dos reuniones mañana.", "¿qué tengo mañana?", TZ)).toBeNull();
  });
});

describe("an explicit email request", () => {
  it("is recognized only when no document or Knowledge source is named", () => {
    expect(explicitEmail("Fijate en el mail de la facultad si la clase es presencial")).toBe(true);
    expect(explicitEmail("Buscá en mis apuntes y en el mail")).toBe(false);
    expect(explicitEmail("¿Qué dice el PDF que subí?")).toBe(false);
  });

  it("keeps document matches off the Canvas, and email replaces them", () => {
    expect(beforePresenting("knowledge.search", [], { email: true }).present).toBe(false);
    const earlier = [{ tool: "knowledge.search", ids: ["k1"] }];
    expect(beforePresenting("email.search", earlier, { email: true }).dismiss).toEqual(["k1"]);
    // Without the request, Knowledge shows as usual.
    expect(beforePresenting("knowledge.search", []).present).toBe(true);
  });
});

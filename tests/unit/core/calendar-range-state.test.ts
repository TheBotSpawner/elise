import { describe, expect, it } from "vitest";

import type { AuthContext } from "@/application/auth-context";
import { WorkspaceSession } from "@/application/workspace-service";
import { executeToolCall, type ToolCallOutcome } from "@/core/agents/executor";
import type { CalendarEvent, EventQuery } from "@/core/capabilities/calendar";
import {
  calendarPayload,
  dayBlocks,
  eventsOn,
  isCovered,
  mergeFetched,
  navigate,
  presentationNewer,
  visibleEvents,
  type CalendarPayload,
} from "@/core/workspace/calendar";
import { changeOf } from "@/core/workspace/lifecycle";
import { emptyWorkspace } from "@/core/workspace/model";

import { binding, makeCtx, makePorts } from "../../fixtures/core-fakes";

/**
 * Calendar view is presentation; calendar events are data (ADR-033 §range state). Switching
 * Week → Year → Week must never lose the week. Synthetic data, a provider that honours the
 * read limit (like Google's maxResults).
 */

const TZ = "America/Argentina/Buenos_Aires";
const TODAY = "2026-10-03";
const AT = "2026-10-03T15:00:00.000Z";

const ev = (id: string, title: string, start: string, end: string, calendarId = "cal-p") =>
  ({
    id,
    calendarId,
    calendarName: calendarId === "cal-w" ? "Trabajo" : "Personal",
    title,
    description: null,
    location: null,
    start,
    end,
    allDay: start.length === 10,
    attendees: [],
    status: "confirmed",
    url: null,
    provenance: { providerKey: "google", connectionId: "c1", externalId: id, source: "Personal" },
  }) as CalendarEvent;

const week = [
  ev("m", "Meeting", "2026-09-30T13:00:00Z", "2026-09-30T13:30:00Z"),
  ev("t", "Theatre", "2026-09-30T23:00:00Z", "2026-10-01T01:00:00Z"),
  ev("b", "Birthday", "2026-10-02", "2026-10-03"),
];
// A busy year: 60 events in January and February come before the week in any listing.
const earlier = Array.from({ length: 60 }, (_, i) => {
  const d = `2026-0${1 + Math.floor(i / 31)}-${String((i % 28) + 1).padStart(2, "0")}`;
  return ev(`e${i}`, `Early ${i}`, `${d}T12:00:00Z`, `${d}T13:00:00Z`);
});
const all = [...earlier, ...week];

/** Like Google: events in [timeMin, timeMax), sorted, at most `limit`. */
function provider(events = all) {
  const reads: EventQuery[] = [];
  let gate: Promise<void> | null = null;
  return {
    reads,
    hold() {
      let open!: () => void;
      gate = new Promise((r) => (open = r));
      return () => {
        gate = null;
        open();
      };
    },
    impl: {
      listCalendars: async () => [],
      listEvents: async (q: EventQuery) => {
        reads.push(q);
        if (gate) await gate;
        const start = (e: CalendarEvent) =>
          Date.parse(e.start.length === 10 ? `${e.start}T03:00:00Z` : e.start);
        return events
          .filter((e) => start(e) >= q.timeMin.getTime() && start(e) < q.timeMax.getTime())
          .sort((a, b) => start(a) - start(b))
          .slice(0, q.limit);
      },
    },
  };
}

const auth = {
  userId: "user-1",
  workspaceId: "ws-1",
  profile: { locale: "es", timezone: TZ },
  db: { from: () => ({ upsert: async () => ({ error: null }) }) },
} as unknown as AuthContext;

function setup(p = provider()) {
  const { ports } = makePorts(
    [
      binding({
        connectionId: "c1",
        capability: "calendar",
        providerKey: "google",
        label: "Personal",
        isDefault: true,
      }),
    ],
    { c1: p.impl },
  );
  const session = new WorkspaceSession(auth, { kind: "conversation", id: "c" }, emptyWorkspace());
  const ctx = makeCtx({ workspace: session, now: new Date(AT) });
  const call = (name: string, args: unknown) => executeToolCall(ports, ctx, { name, args });
  return { session, call, p };
}

/** "Mostrame mi calendario para esta semana": the model's own read, presented on the Canvas. */
async function showWeek(s: ReturnType<typeof setup>) {
  const args = { from: "2026-09-28", to: "2026-10-04" };
  const out = (await s.call("calendar.listEvents", args)) as ToolCallOutcome;
  s.session.present("calendar.listEvents", "call-1", out, { tool: "calendar.listEvents", args });
}
const cal = (s: ReturnType<typeof setup>) =>
  s.session.state().surfaces.find((x) => x.type === "calendar")!;
const shown = (s: ReturnType<typeof setup>) => cal(s).payload as CalendarPayload;
const weekTitles = (p: CalendarPayload) =>
  ["2026-09-30", "2026-10-02"].flatMap((d) =>
    eventsOn(visibleEvents(p), d, TZ).map((e) => e.title),
  );

describe("Week → Year → Week keeps the week (the real failure)", () => {
  it("by voice/chat (ui.show): same week, same 3 events, same placement", async () => {
    const s = setup();
    await showWeek(s);
    expect(weekTitles(shown(s))).toEqual(["Meeting", "Theatre", "Birthday"]);

    await s.call("ui.show", { what: "collection", as: "year" });
    expect(shown(s).view).toBe("year");
    await s.call("ui.show", { what: "collection", as: "week" });

    const p = shown(s);
    expect(p.view).toBe("week");
    expect(p.anchor >= "2026-09-28" && p.anchor <= "2026-10-04").toBe(true); // the same week
    expect(weekTitles(p)).toEqual(["Meeting", "Theatre", "Birthday"]);
    expect(dayBlocks(p.events, "2026-09-30", TZ).map((b) => [b.item.title, b.from])).toEqual([
      ["Meeting", 600],
      ["Theatre", 1200],
    ]);
    expect(s.session.state().surfaces.filter((x) => x.type === "calendar")).toHaveLength(1);
  });

  it("the year's density is kept apart from the detailed events (aggregates never replace them)", async () => {
    const s = setup();
    await showWeek(s);
    await s.call("ui.show", { what: "collection", as: "year" });
    const p = shown(s);
    expect(p.summary?.year).toBe("2026");
    expect(p.summary?.counts["2026-09-30"]).toBe(2);
    expect(weekTitles(p)).toEqual(["Meeting", "Theatre", "Birthday"]);
  });

  it("a week that is loaded needs no read when coming back", async () => {
    const s = setup();
    await showWeek(s);
    await s.call("ui.show", { what: "collection", as: "year" });
    const reads = s.p.reads.length;
    await s.call("ui.show", { what: "collection", as: "week" });
    expect(s.p.reads.length).toBe(reads);
  });
});

describe("round trips", () => {
  it("Week → Year → Month → Day → Month → Week → Agenda → Week: nothing lost, nothing doubled", async () => {
    const s = setup();
    await showWeek(s);
    for (const as of ["year", "month", "day", "month", "week", "agenda", "week"] as const) {
      await s.call("ui.show", { what: "collection", as });
      const ids = shown(s).events.map((e) => e.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
    expect(shown(s).view).toBe("week");
    expect(weekTitles(shown(s))).toEqual(["Meeting", "Theatre", "Birthday"]);
  });
});

describe("range cache", () => {
  const base = () =>
    calendarPayload({
      events: week,
      from: "2026-09-28T03:00:00Z",
      to: "2026-10-05T03:00:00Z",
      timezone: TZ,
      today: TODAY,
    });

  it("a truncated read never counts as loaded", () => {
    const p = base();
    const merged = mergeFetched(p, {
      events: earlier.slice(0, 50),
      range: { from: "2026-01-01", to: "2027-01-01" },
      complete: false,
    });
    expect(isCovered(merged, { from: "2026-09-28", to: "2026-10-05" })).toBe(true);
    expect(isCovered(merged, { from: "2026-01-01", to: "2027-01-01" })).toBe(false);
    expect(merged.events.map((e) => e.id)).toEqual(expect.arrayContaining(["m", "t", "b", "e0"]));
  });

  it("overlapping ranges merge without losing or doubling (week Sep 28–Oct 4 + month Oct)", () => {
    const p = base();
    const oct = [
      week[1]!,
      week[2]!,
      ev("o", "October thing", "2026-10-20T12:00:00Z", "2026-10-20T13:00:00Z"),
    ];
    const merged = mergeFetched(p, {
      events: oct,
      range: { from: "2026-10-01", to: "2026-11-01" },
      complete: true,
    });
    expect(merged.events.map((e) => e.id).sort()).toEqual(["b", "m", "o", "t"]);
    expect(isCovered(merged, { from: "2026-09-28", to: "2026-11-01" })).toBe(true);
  });

  it("a fetched range is authoritative inside it: what's gone there is removed, outside is kept", () => {
    const p = base();
    const merged = mergeFetched(p, {
      events: [week[0]!], // Wednesday re-read: the theatre was deleted
      range: { from: "2026-09-30", to: "2026-10-01" },
      complete: true,
    });
    expect(merged.events.map((e) => e.id).sort()).toEqual(["b", "m"]);
  });

  it("data loaded for one calendar doesn't satisfy all calendars", () => {
    const p = { ...base(), scope: "cal-w" };
    expect(isCovered(p, { from: "2026-09-28", to: "2026-10-05" }, "all")).toBe(false);
    expect(isCovered(p, { from: "2026-09-28", to: "2026-10-05" }, "cal-w")).toBe(true);
  });

  it("loading is not empty: unloaded days are reported as such", () => {
    const p = navigate(base(), { view: "month" }, TODAY);
    expect(p.fetch).toEqual({ from: "2026-10-01", to: "2026-11-01" });
    expect(isCovered(p.payload, { from: "2026-10-01", to: "2026-11-01" })).toBe(false);
    expect(weekTitles(p.payload)).toEqual(["Meeting", "Theatre", "Birthday"]); // kept meanwhile
  });

  it("bounded persistence keeps the events nearest the anchor and shrinks coverage to match", () => {
    const many = Array.from({ length: 260 }, (_, i) => {
      const d = new Date(Date.UTC(2026, 0, 1 + Math.floor(i * 1.3)));
      const iso = d.toISOString().slice(0, 10);
      return ev(`x${i}`, `X${i}`, `${iso}T12:00:00Z`, `${iso}T13:00:00Z`);
    });
    const merged = mergeFetched(base(), {
      events: [...many, ...week],
      range: { from: "2026-01-01", to: "2027-01-01" },
      complete: true,
    });
    expect(merged.events.length).toBeLessThanOrEqual(200);
    expect(weekTitles(merged)).toEqual(expect.arrayContaining(["Meeting", "Theatre", "Birthday"]));
    expect(isCovered(merged, { from: "2026-01-01", to: "2027-01-01" })).toBe(false);
    expect(isCovered(merged, { from: "2026-09-28", to: "2026-10-05" })).toBe(true);
  });
});

describe("races: a late response never overrides a newer choice", () => {
  it("presentation applies only if newer; data from a late response still enriches the cache", () => {
    const p = {
      ...calendarPayload({
        events: week,
        from: "2026-09-28T03:00:00Z",
        to: "2026-10-05T03:00:00Z",
        timezone: TZ,
        today: TODAY,
      }),
      seq: 5,
    };
    expect(presentationNewer(p, 4)).toBe(false);
    expect(presentationNewer(p, 6)).toBe(true);
  });

  it("rapid Week → Year → Month → Week: Week wins even when Year and Month answer last", async () => {
    const s = setup();
    await showWeek(s);
    const release = s.p.hold();
    const year = s.call("ui.show", { what: "collection", as: "year" });
    const month = s.call("ui.show", { what: "collection", as: "month" });
    await s.call("ui.show", { what: "collection", as: "week" }); // loaded: no read, applies now
    release();
    await Promise.all([year, month]);
    expect(shown(s).view).toBe("week");
    expect(weekTitles(shown(s))).toEqual(["Meeting", "Theatre", "Birthday"]);
  });

  it("a failed read keeps what was known", async () => {
    const s = setup();
    await showWeek(s);
    s.p.impl.listEvents = async () => {
      throw new Error("offline");
    };
    await s.call("ui.show", { what: "collection", as: "year" });
    expect(weekTitles(shown(s))).toEqual(["Meeting", "Theatre", "Birthday"]);
  });
});

describe("mutations reconcile every loaded range", () => {
  it("a created event appears in week and year; switching views shows no stale data", async () => {
    const p = provider();
    const s = setup(p);
    await showWeek(s);
    await s.call("ui.show", { what: "collection", as: "year" });
    await s.call("ui.show", { what: "collection", as: "week" });
    const created = ev("n", "New", "2026-10-02T15:00:00Z", "2026-10-02T16:00:00Z");
    all.push(created);
    try {
      const change = changeOf(
        "calendar.createEvent",
        { name: "createEvent", kind: "write" },
        { status: "succeeded", target: { type: "calendar_event", id: "n" } },
      )!;
      await s.session.reconcile(
        change,
        async (q) => s.call(q.tool, q.args) as Promise<ToolCallOutcome>,
      );
      expect(eventsOn(shown(s).events, "2026-10-02", TZ).map((e) => e.title)).toContain("New");
      expect(shown(s).view).toBe("week");
      await s.call("ui.show", { what: "collection", as: "year" });
      expect(shown(s).summary?.counts["2026-10-02"]).toBe(2);
    } finally {
      all.pop();
    }
  });
});

import { describe, expect, it } from "vitest";

import type { AuthContext } from "@/application/auth-context";
import {
  createScheduledConversation,
  openScheduledConversation,
  presentBriefing,
} from "@/application/scheduled-conversation";
import { WorkspaceSession } from "@/application/workspace-service";
import {
  executeToolCall,
  INTERNAL_CONNECTION_ID,
  type ToolCallOutcome,
} from "@/core/agents/executor";
import type { ToolDisplay } from "@/core/agents/tools";
import {
  briefCanvas,
  focusSurface,
  SPOKEN_BRIEF_LIMIT,
  spokenBrief,
  type BriefRead,
} from "@/core/briefs/canvas";
import { assembleBrief, type MorningBrief } from "@/core/briefs/morning-brief";
import type { CalendarEvent } from "@/core/capabilities/calendar";
import type { Task } from "@/core/capabilities/tasks";
import { surfacesFromOutcome } from "@/core/workspace/from-results";
import { changeOf, datasetKey } from "@/core/workspace/lifecycle";
import { applyOps, emptyWorkspace, type WorkspaceState } from "@/core/workspace/model";
import { resolveComposition } from "@/features/workspace/canvas/composition";

import { makeCtx, makePorts } from "../../fixtures/core-fakes";

const NOW = new Date("2026-10-05T11:00:00Z"); // 08:00 in Buenos Aires
const TZ = "America/Argentina/Buenos_Aires";
const AT = NOW.toISOString();

const task = (id: string, title: string, dueDate: string | null): Task =>
  ({
    id,
    title,
    description: null,
    notes: null,
    status: "pending",
    priority: "medium",
    category: null,
    dueDate,
    completedAt: null,
    createdAt: AT,
    updatedAt: AT,
    provenance: { providerKey: "elise_native", connectionId: "c", externalId: id, source: "ELISE" },
  }) as Task;

const event = (id: string, title: string, start: string, end: string): CalendarEvent =>
  ({
    id,
    title,
    start,
    end,
    allDay: false,
    location: null,
    attendees: [{ email: "client@example.com", name: null, self: false, responseStatus: null }],
    organizer: null,
    status: "confirmed",
    calendarId: "primary",
    url: null,
    provenance: { providerKey: "google", connectionId: "g", externalId: id, source: "Work" },
  }) as unknown as CalendarEvent;

const weather = {
  mode: "hourly" as const,
  location: { name: "Buenos Aires", detail: null, source: "configured" as const },
  timezone: TZ,
  period: null,
  current: null,
  days: [
    {
      date: "2026-10-05",
      condition: "rain" as const,
      min: 14,
      max: 22,
      precipitationProbability: 70,
      precipitationSum: 3,
      windMax: 10,
      sunrise: null,
      sunset: null,
    },
  ],
  hours: [],
  attribution: { name: "Open-Meteo", url: "https://open-meteo.com/" },
};

const TASKS = [
  task("t1", "Pagar factura", "2026-10-01"),
  task("t2", "Enviar propuesta", "2026-10-05"),
  task("t3", "Ordenar el garage", null),
];

function setup(over: { events?: CalendarEvent[]; news?: boolean } = {}) {
  const events = over.events ?? [];
  const brief = assembleBrief({
    now: NOW,
    timezone: TZ,
    locale: "es",
    events,
    tasks: TASKS,
    weather,
    warnings: [],
  });
  const reads: BriefRead[] = [
    {
      block: "calendar",
      tool: "calendar.listEvents",
      args: { from: "2026-10-05", limit: 50 },
      display: { kind: "event_list", events, from: "2026-10-05", to: "2026-10-05" },
    },
    {
      block: "tasks",
      tool: "tasks.list",
      args: { status: "open", limit: 12 },
      display: { kind: "task_list", tasks: TASKS },
    },
    {
      block: "weather",
      tool: "weather.forecast",
      args: { when: "today" },
      display: { kind: "weather", weather } as unknown as ToolDisplay,
    },
    {
      block: "news",
      tool: "web.searchNews",
      args: { query: "AI", recency: "day" },
      display: {
        kind: "web_news",
        query: "AI",
        recency: "day",
        retrievedAt: AT,
        events: over.news
          ? [
              {
                headline: "A model launch",
                items: [
                  {
                    title: "Launch",
                    url: "https://example.com/a",
                    domain: "example.com",
                    publishedAt: AT,
                    snippet: "…",
                  },
                ],
              },
            ]
          : [],
      },
    },
  ];
  return { brief, reads };
}

function fakeAuth(db: unknown = null) {
  const saved: { surfaces: unknown[]; conversation_id: string }[] = [];
  const auth = {
    userId: "user-1",
    workspaceId: "ws-1",
    profile: { locale: "es", timezone: TZ, displayName: "Sam" },
    db: db ?? {
      from: () => ({
        upsert: async (row: { surfaces: unknown[]; conversation_id: string }) => {
          saved.push(row);
          return { error: null };
        },
      }),
    },
  } as unknown as AuthContext;
  return { auth, saved };
}

const session = (auth: AuthContext) =>
  new WorkspaceSession(auth, { kind: "conversation", id: "conv-1" }, emptyWorkspace());

const outcome = (display: ToolDisplay): ToolCallOutcome => ({
  status: "succeeded",
  output: null,
  display,
  actionId: null,
  providerLabel: "elise",
});

// ── Relevance ────────────────────────────────────────────────────────────────

describe("a brief's Surfaces are chosen by relevance", () => {
  it("keeps the calendar (quiet when the day is empty), the tasks that matter and the weather; omits empty news", () => {
    const { brief, reads } = setup();
    const items = briefCanvas(brief, reads);
    expect(items.map((i) => i.tool)).toEqual([
      "calendar.listEvents",
      "tasks.list",
      "weather.forecast",
    ]);
    const calendar = items.find((i) => i.tool === "calendar.listEvents")!;
    expect(calendar.priority).toBeLessThan(40);
    // Only today's and overdue tasks; "Ordenar el garage" (no date) isn't the brief's business.
    const tasks = items.find((i) => i.tool === "tasks.list")!.display;
    expect(tasks.kind === "task_list" && tasks.tasks.map((t) => t.id).sort()).toEqual(["t1", "t2"]);
  });

  it("a day with meetings leads with the calendar; news with events joins quietly", () => {
    const { brief, reads } = setup({
      events: [
        event("e1", "Client review", "2026-10-05T14:00:00-03:00", "2026-10-05T15:00:00-03:00"),
      ],
      news: true,
    });
    const items = briefCanvas(brief, reads);
    expect(items.find((i) => i.tool === "calendar.listEvents")!.priority).toBeGreaterThanOrEqual(
      70,
    );
    expect(items.find((i) => i.tool === "web.searchNews")!.priority).toBeLessThan(40);
  });

  it("the spoken synthesis is short, points to the screen, and never reads every item", () => {
    const { brief } = setup();
    const text = spokenBrief(brief, "es");
    expect(text.length).toBeLessThanOrEqual(SPOKEN_BRIEF_LIMIT);
    expect(text).toMatch(/pantalla/);
    expect(text).not.toContain("Ordenar el garage");
  });

  it("'Today's focus' is a short lead synthesis only when there is focus", () => {
    const { brief } = setup();
    expect(focusSurface(brief, "es", null)).toBeNull();
    const withFocus: MorningBrief = {
      ...brief,
      focus: [
        {
          name: "Client A",
          kind: "client",
          meetings: [{ title: "Review", start: AT }],
          tasks: 2,
          replies: 1,
          examDate: null,
          review: [],
        },
      ],
    };
    const s = focusSurface(withFocus, "es", null)!;
    expect(s.type).toBe("summary");
    expect(s.priority).toBeGreaterThanOrEqual(85);
  });
});

// ── The normal Canvas path ───────────────────────────────────────────────────

describe("a scheduled brief lives in the normal Live Canvas", () => {
  function presented() {
    const { brief, reads } = setup({
      events: [
        event("e1", "Client review", "2026-10-05T14:00:00-03:00", "2026-10-05T15:00:00-03:00"),
      ],
    });
    const { auth, saved } = fakeAuth();
    const s = session(auth);
    const traces = presentBriefing(s, { items: briefCanvas(brief, reads), focus: null });
    return { s, traces, saved, auth };
  }

  it("each read becomes a refreshable Surface with its own query and dataset", async () => {
    const { s, traces, saved } = presented();
    const surfaces = s.state().surfaces;
    expect(surfaces.map((x) => x.type).sort()).toEqual(["calendar", "task_list", "weather"]);
    const tasks = surfaces.find((x) => x.type === "task_list")!;
    expect(tasks.query).toEqual({ tool: "tasks.list", args: { status: "open", limit: 12 } });
    expect(tasks.dataset).toBe(datasetKey("tasks.list", { status: "open", limit: 12 }));
    expect(traces.every((t) => t.surfaceIds?.length)).toBe(true);
    await s.flush();
    expect(saved.at(-1)!.conversation_id).toBe("conv-1");
  });

  it("composes spatially on desktop and with the normal responsive rules on mobile", () => {
    const { s } = presented();
    const input = (device: "desktop" | "mobile") => ({
      state: s.state(),
      device,
      hasMessages: true,
      running: false,
      activeSteps: 0,
      now: NOW.getTime(),
    });
    const desktop = resolveComposition(input("desktop"));
    expect(desktop.slots.length).toBeGreaterThanOrEqual(3);
    expect(new Set(desktop.slots.map((x) => x.zone)).size).toBeGreaterThan(1);
    const mobile = resolveComposition(input("mobile"));
    expect(mobile.slots.length + mobile.shelf.length).toBe(3);
  });

  it("completing a task refreshes the Task Surface in place (no stale data, no duplicate)", async () => {
    const { s } = presented();
    const before = s.state().surfaces.find((x) => x.type === "task_list")!;
    const change = changeOf(
      "tasks.complete",
      { name: "complete", kind: "write" },
      { status: "succeeded", target: { type: "task", id: "t1" } },
    )!;
    const updated = await s.reconcile(change, async (q) => {
      expect(q.tool).toBe("tasks.list");
      return outcome({ kind: "task_list", tasks: [TASKS[1]!] });
    });
    expect(updated).toBe(1);
    const after = s.state().surfaces.filter((x) => x.type === "task_list");
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(before.id);
    expect(JSON.stringify(after[0]!.payload)).not.toContain("Pagar factura");
  });

  it("reading the same thing again updates that Surface instead of adding another", () => {
    const { s } = presented();
    const count = s.state().surfaces.length;
    s.present("tasks.list", "call-2", outcome({ kind: "task_list", tasks: TASKS }), {
      tool: "tasks.list",
      args: { status: "open", limit: 12 },
    });
    expect(s.state().surfaces).toHaveLength(count);
  });

  it("focus, back, pin and dismiss work on scheduled Surfaces like on any other", () => {
    const { s } = presented();
    const email = s.state().surfaces.find((x) => x.type === "task_list")!;
    let state: WorkspaceState = applyOps(s.state(), [{ op: "focus", id: email.id, at: AT }]);
    expect(state.focusId).toBe(email.id);
    state = applyOps(state, [{ op: "focus", id: null, at: AT }]);
    expect(state.focusId).toBeNull();
    expect(state.surfaces).toHaveLength(s.state().surfaces.length);
    state = applyOps(state, [{ op: "pin", id: email.id, pinned: true, at: AT }]);
    expect(state.surfaces.find((x) => x.id === email.id)!.pinned).toBe(true);
    const weather = state.surfaces.find((x) => x.type === "weather")!;
    state = applyOps(state, [{ op: "dismiss", id: weather.id, at: AT }]);
    expect(state.surfaces.some((x) => x.id === weather.id)).toBe(false);
  });
});

// ── Persistence: Schedule → Run → Conversation ───────────────────────────────

/** Enough of the Supabase client for these flows; records what was written. */
function fakeDb(seed: {
  conversation?: { id: string; origin: string } | null;
  firstMessage?: unknown;
  live?: { expires_at: string } | null;
}) {
  const inserts: Record<string, Record<string, unknown>[]> = {};
  const upserts: Record<string, unknown>[] = [];
  const db = {
    from(table: string) {
      let inserted: Record<string, unknown> | null = null;
      const q = {
        select: () => q,
        eq: () => q,
        order: () => q,
        limit: () => q,
        insert(row: Record<string, unknown>) {
          (inserts[table] ??= []).push(row);
          inserted = row;
          return q;
        },
        upsert: async (row: Record<string, unknown>) => {
          upserts.push(row);
          return { error: null };
        },
        single: async () => ({
          data: inserted
            ? { id: table === "conversations" ? "conv-new" : "row", ...inserted }
            : null,
          error: null,
        }),
        maybeSingle: async () => ({
          data:
            table === "conversations"
              ? (seed.conversation ?? null)
              : table === "messages"
                ? seed.firstMessage
                  ? { metadata: seed.firstMessage }
                  : null
                : table === "live_workspaces"
                  ? (seed.live ?? null)
                  : null,
        }),
        then: (resolve: (v: { error: null }) => void) => resolve({ error: null }),
      };
      return q;
    },
  };
  return { db, inserts, upserts };
}

describe("a scheduled run opens a conversation", () => {
  const input = () => {
    const { brief, reads } = setup();
    return {
      scheduleId: "11111111-1111-4111-8111-111111111111",
      runId: "22222222-2222-4222-8222-222222222222",
      title: "Morning Brief — 5 oct",
      name: "Morning Brief",
      spoken: spokenBrief(brief, "es"),
      presentation: { items: briefCanvas(brief, reads), focus: null },
    };
  };

  it("creates the conversation (origin scheduled, linked to its run), its Canvas and ELISE's first message", async () => {
    const { db, inserts, upserts } = fakeDb({ conversation: null });
    const { auth } = fakeAuth(db);
    const id = await createScheduledConversation(auth, input());
    expect(id).toBe("conv-new");
    expect(inserts.conversations![0]).toMatchObject({
      origin: "scheduled",
      schedule_run_id: "22222222-2222-4222-8222-222222222222",
      title: "Morning Brief — 5 oct",
    });
    const message = inserts.messages![0]!;
    expect(message).toMatchObject({ role: "assistant", conversation_id: "conv-new" });
    const meta = message.metadata as {
      tools: { surfaceIds?: string[] }[];
      toolNotes: string[];
      scheduled: { runId: string };
    };
    expect(meta.scheduled.runId).toBe("22222222-2222-4222-8222-222222222222");
    expect(meta.tools.every((t) => t.surfaceIds?.length)).toBe(true);
    // Follow-ups know what's on screen by id ("marcá la primera como hecha").
    expect(meta.toolNotes.join(" ")).toContain("tasks.list ✓");
    const canvas = upserts.at(-1) as { conversation_id: string; surfaces: { type: string }[] };
    expect(canvas.conversation_id).toBe("conv-new");
    expect(canvas.surfaces.map((x) => x.type)).toContain("task_list");
  });

  it("a retried run reopens the same conversation (never a second one)", async () => {
    const { db, inserts } = fakeDb({ conversation: { id: "conv-1", origin: "scheduled" } });
    const { auth } = fakeAuth(db);
    expect(await createScheduledConversation(auth, input())).toBe("conv-1");
    expect(inserts.conversations).toBeUndefined();
    expect(inserts.messages).toBeUndefined();
  });

  it("reopening an old brief rebuilds its Canvas once the working state expired", async () => {
    const x = input();
    const { db, upserts } = fakeDb({
      conversation: { id: "conv-1", origin: "scheduled" },
      firstMessage: {
        scheduled: {
          scheduleId: x.scheduleId,
          runId: x.runId,
          name: x.name,
          spoken: x.spoken,
          presentation: x.presentation,
        },
      },
      live: { expires_at: "2026-10-01T00:00:00Z" },
    });
    const { auth } = fakeAuth(db);
    const info = await openScheduledConversation(auth, "conv-1");
    expect(info).toEqual({ name: "Morning Brief", spoken: x.spoken });
    const canvas = upserts.at(-1) as { surfaces: { type: string }[] };
    expect(canvas.surfaces.map((s) => s.type).sort()).toEqual(["calendar", "task_list", "weather"]);
  });

  it("a current workspace (even one the user emptied) is never rebuilt over", async () => {
    const x = input();
    const { db, upserts } = fakeDb({
      conversation: { id: "conv-1", origin: "scheduled" },
      firstMessage: { scheduled: { ...x, presentation: x.presentation } },
      live: { expires_at: new Date(Date.now() + 3_600_000).toISOString() },
    });
    await openScheduledConversation(fakeAuth(db).auth, "conv-1");
    expect(upserts).toHaveLength(0);
  });

  it("a normal conversation is not a scheduled one", async () => {
    const { db } = fakeDb({ conversation: { id: "conv-1", origin: "user" } });
    expect(await openScheduledConversation(fakeAuth(db).auth, "conv-1")).toBeNull();
  });
});

describe("'my brief now' in chat uses the same Surfaces", () => {
  it("briefs.today hands the Canvas typed Surfaces, never a report-shaped one", async () => {
    const { brief, reads } = setup();
    const { ports } = makePorts([], {
      [INTERNAL_CONNECTION_ID]: { today: async () => ({ brief, reads }) },
    });
    const out = await executeToolCall(ports, makeCtx({ now: NOW, timezone: TZ }), {
      name: "briefs.today",
      args: {},
    });
    expect(out.status).toBe("succeeded");
    const display = (out as Extract<typeof out, { status: "succeeded" }>).display!;
    expect(display.kind === "morning_brief" && display.present?.items).toEqual(
      briefCanvas(brief, reads),
    );
    // The generic path presents nothing for it: only its own Surfaces appear.
    expect(surfacesFromOutcome("briefs.today", out, { key: "k", intentId: null })).toEqual([]);
  });
});

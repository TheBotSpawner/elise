import { describe, expect, it, vi } from "vitest";

import { executeToolCall } from "@/core/agents/executor";
import { assembleBrief } from "@/core/briefs/morning-brief";
import type { CalendarEvent } from "@/core/capabilities/calendar";
import { AppError } from "@/core/errors";
import {
  dispatchDue,
  executeRun,
  resumeAfterApproval,
  runNow,
  type ActionHandler,
  type RunPatch,
  type RunRecord,
  type RunResult,
  type RunnerPorts,
  type ScheduleRecord,
  type ScheduleStore,
} from "@/core/schedules/runner";
import { isMissed, nextOccurrence, scheduleInputSchema } from "@/core/schedules/schedule";

import { makeCtx, makePorts } from "../../fixtures/core-fakes";

const WS = "11111111-1111-4111-8111-111111111111";
const BA = "America/Argentina/Buenos_Aires";

/** In-memory store with the same guarantees as the database constraints. */
class MemoryStore implements ScheduleStore {
  schedules = new Map<string, ScheduleRecord>();
  runs: (RunRecord & { patch: RunPatch })[] = [];
  results = new Map<string, { id: string; result: RunResult }>();
  notifications = new Set<string>();
  members = new Set<string>(["user-1"]);

  async dueSchedules(now: Date) {
    return [...this.schedules.values()].filter(
      (s) => s.status === "active" && !s.archived && s.nextRunAt && s.nextRunAt <= now,
    );
  }
  async advance(
    id: string,
    expected: Date,
    next: Date | null,
    patch: { status?: ScheduleRecord["status"] },
  ) {
    const s = this.schedules.get(id)!;
    if (s.status !== "active" || s.nextRunAt?.getTime() !== expected.getTime()) return false;
    s.nextRunAt = next;
    if (patch.status) s.status = patch.status;
    return true;
  }
  async createRun(
    schedule: ScheduleRecord,
    r: { trigger: RunRecord["trigger"]; scheduledFor: Date; status: RunRecord["status"] },
  ) {
    const dup = this.runs.some(
      (x) => x.scheduleId === schedule.id && x.scheduledFor.getTime() === r.scheduledFor.getTime(),
    );
    const active = this.runs.some(
      (x) =>
        x.scheduleId === schedule.id &&
        ["queued", "running", "waiting_for_approval"].includes(x.status),
    );
    if (dup || (r.status === "queued" && active)) return null;
    const run = {
      id: crypto.randomUUID(),
      workspaceId: schedule.workspaceId,
      scheduleId: schedule.id,
      jobId: crypto.randomUUID(),
      trigger: r.trigger,
      status: r.status,
      scheduledFor: r.scheduledFor,
      patch: {},
    };
    this.runs.push(run);
    return run;
  }
  async loadRun(workspaceId: string, runId: string) {
    const run = this.runs.find((r) => r.id === runId && r.workspaceId === workspaceId);
    if (!run) return null;
    return { run: { ...run }, schedule: this.schedules.get(run.scheduleId)! };
  }
  async runByApproval(approvalId: string) {
    return this.runs.find((r) => r.patch.approvalId === approvalId) ?? null;
  }
  async ownerIsActiveMember(_ws: string, userId: string) {
    return this.members.has(userId);
  }
  async updateRun(run: RunRecord, patch: RunPatch) {
    const r = this.runs.find((x) => x.id === run.id)!;
    Object.assign(r.patch, patch);
    if (patch.status) r.status = patch.status;
  }
  async saveResult(run: RunRecord, _s: ScheduleRecord, result: RunResult) {
    const existing = this.results.get(run.id);
    if (existing) return existing.id;
    const id = crypto.randomUUID();
    this.results.set(run.id, { id, result });
    return id;
  }
  async notify(run: RunRecord, _s: ScheduleRecord, n: { type: string }) {
    this.notifications.add(`${run.id}:${n.type}`);
  }
  async setScheduleStatus(s: ScheduleRecord, status: ScheduleRecord["status"]) {
    this.schedules.get(s.id)!.status = status;
  }
  async expireStaleRuns() {
    return 0;
  }
}

function setup(handler?: ActionHandler, now = new Date("2026-09-29T10:30:00Z")) {
  const store = new MemoryStore();
  const enqueued: { key: string; runId: string }[] = [];
  const handle = vi.fn<ActionHandler>(
    handler ??
      (async () => ({
        kind: "result",
        result: { type: "morning_brief", title: "Morning Brief", content: { ok: true } },
        warnings: [],
      })),
  );
  const clock = { now };
  const ports: RunnerPorts = {
    store,
    runtime: {
      enqueue: async (job) => {
        enqueued.push({
          key: job.idempotencyKey,
          runId: (job.payload as { scheduleRunId: string }).scheduleRunId,
        });
        return { runtimeJobId: `run_${enqueued.length}` };
      },
      cancel: async () => undefined,
    },
    handlers: { morning_brief: handle },
    now: () => clock.now,
  };
  const schedule: ScheduleRecord = {
    id: crypto.randomUUID(),
    workspaceId: WS,
    ownerUserId: "user-1",
    name: "Morning Brief",
    status: "active",
    timezone: BA,
    definition: { kind: "weekly", days: [1, 2, 3, 4, 5], time: "07:30" },
    actionType: "morning_brief",
    configuration: {},
    instructions: null,
    delivery: { notify: "in_app" },
    // Tuesday 2026-09-29 07:30 in Buenos Aires.
    nextRunAt: new Date("2026-09-29T10:30:00Z"),
    archived: false,
  };
  store.schedules.set(schedule.id, schedule);
  return { store, ports, enqueued, handle, schedule, clock };
}

describe("schedule timing", () => {
  it("computes weekday occurrences in the schedule's timezone", () => {
    const def = { kind: "weekly" as const, days: [1, 2, 3, 4, 5], time: "07:30" };
    // Friday 08:00 local → next is Monday 07:30 local (10:30Z).
    expect(nextOccurrence(def, BA, new Date("2026-10-02T11:00:00Z"))?.toISOString()).toBe(
      "2026-10-05T10:30:00.000Z",
    );
  });

  it("keeps 07:30 local across a DST change", () => {
    const def = { kind: "weekly" as const, days: [0, 1, 2, 3, 4, 5, 6], time: "07:30" };
    const ny = "America/New_York";
    // EDT (UTC-4) on Oct 31, EST (UTC-5) from Nov 1 2026.
    expect(nextOccurrence(def, ny, new Date("2026-10-31T00:00:00Z"))?.toISOString()).toBe(
      "2026-10-31T11:30:00.000Z",
    );
    expect(nextOccurrence(def, ny, new Date("2026-11-02T00:00:00Z"))?.toISOString()).toBe(
      "2026-11-02T12:30:00.000Z",
    );
  });

  it("one-time schedules run once and then have no next occurrence", () => {
    const def = { kind: "once" as const, at: "2026-10-01T18:00" };
    const at = nextOccurrence(def, BA, new Date("2026-09-29T00:00:00Z"));
    expect(at?.toISOString()).toBe("2026-10-01T21:00:00.000Z");
    expect(nextOccurrence(def, BA, at!)).toBeNull();
  });

  it("a Morning Brief hours late is missed, a few minutes late is fine", () => {
    const at = new Date("2026-09-29T10:30:00Z");
    expect(isMissed("morning_brief", at, new Date("2026-09-29T10:40:00Z"))).toBe(false);
    expect(isMissed("morning_brief", at, new Date("2026-09-29T20:00:00Z"))).toBe(true);
  });

  it("validates a structured schedule (never an opaque prompt)", () => {
    const ok = scheduleInputSchema.safeParse({
      name: "Morning Brief",
      actionType: "morning_brief",
      definition: { kind: "weekly", days: [5, 1, 1], time: "07:30" },
      timezone: BA,
      configuration: {},
    });
    expect(ok.success && ok.data.definition).toEqual({
      kind: "weekly",
      days: [1, 5],
      time: "07:30",
    });
    expect(ok.success && ok.data.configuration.blocks).toEqual([
      "calendar",
      "email",
      "needs_reply",
      "tasks",
      "habits",
      "goals",
      "weather",
    ]);
    expect(
      scheduleInputSchema.safeParse({
        name: "x",
        actionType: "morning_brief",
        definition: { kind: "weekly", days: [1], time: "25:00" },
        timezone: "Mars/Olympus",
        configuration: {},
      }).success,
    ).toBe(false);
  });
});

describe("dispatch", () => {
  it("claims each occurrence exactly once, even with concurrent dispatchers", async () => {
    const { ports, enqueued, schedule } = setup();
    await Promise.all([dispatchDue(ports), dispatchDue(ports), dispatchDue(ports)]);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.key).toBe(`schedule-run:${enqueued[0]!.runId}`);
    // Advanced to Wednesday 07:30 local; the schedule stays active.
    expect(schedule.nextRunAt?.toISOString()).toBe("2026-09-30T10:30:00.000Z");
    expect(schedule.status).toBe("active");
  });

  it("records a missed Morning Brief instead of running it in the afternoon", async () => {
    const { ports, enqueued, store } = setup(undefined, new Date("2026-09-29T19:00:00Z"));
    await dispatchDue(ports);
    expect(enqueued).toHaveLength(0);
    expect(store.runs.map((r) => r.status)).toEqual(["missed"]);
  });

  it("does not run paused schedules", async () => {
    const { ports, enqueued, schedule } = setup();
    schedule.status = "paused";
    await dispatchDue(ports);
    expect(enqueued).toHaveLength(0);
  });

  it("skips an occurrence while a previous run is still active", async () => {
    const { ports, store, schedule, enqueued, clock } = setup();
    clock.now = new Date("2026-09-29T10:29:00Z");
    await runNow(ports, schedule);
    clock.now = new Date("2026-09-29T10:30:00Z");
    await dispatchDue(ports);
    expect(enqueued).toHaveLength(1);
    expect(store.runs.map((r) => r.status)).toEqual(["queued", "skipped"]);
  });

  it("completes a one-time schedule after its run", async () => {
    const { ports, schedule } = setup();
    schedule.definition = { kind: "once", at: "2026-09-29T07:30" };
    await dispatchDue(ports);
    expect(schedule.status).toBe("completed");
    expect(schedule.nextRunAt).toBeNull();
  });
});

describe("execution", () => {
  it("Run Now uses the same run + background path, and returns before the work is done", async () => {
    const { ports, schedule, enqueued, handle, store } = setup();
    const run = await runNow(ports, schedule);
    expect(handle).not.toHaveBeenCalled(); // closing the browser now changes nothing
    expect(enqueued[0]!.runId).toBe(run.id);
    await expect(runNow(ports, schedule)).rejects.toMatchObject({ code: "CONFLICT" });

    const status = await executeRun(ports, { workspaceId: WS, scheduleRunId: run.id, attempt: 1 });
    expect(status).toBe("completed");
    expect(store.results.size).toBe(1);
    expect([...store.notifications]).toEqual([`${run.id}:schedule.result_ready`]);
  });

  it("is idempotent: a duplicate delivery neither re-runs nor re-notifies", async () => {
    const { ports, schedule, handle, store } = setup();
    const run = await runNow(ports, schedule);
    await executeRun(ports, { workspaceId: WS, scheduleRunId: run.id, attempt: 1 });
    await executeRun(ports, { workspaceId: WS, scheduleRunId: run.id, attempt: 1 });
    expect(handle).toHaveBeenCalledTimes(1);
    expect(store.results.size).toBe(1);
    expect(store.notifications.size).toBe(1);
  });

  it("completes with a warning when some sources failed", async () => {
    const { ports, schedule, store } = setup(async () => ({
      kind: "result",
      result: { type: "morning_brief", title: "Morning Brief", content: {} },
      warnings: [{ block: "email", code: "AUTH_EXPIRED" }],
    }));
    const run = await runNow(ports, schedule);
    expect(await executeRun(ports, { workspaceId: WS, scheduleRunId: run.id, attempt: 1 })).toBe(
      "completed_with_warning",
    );
    expect(store.results.size).toBe(1);
  });

  it("retries transient failures through the runtime, and stops after the last attempt", async () => {
    const { ports, schedule, store } = setup(async () => {
      throw new AppError("PROVIDER_UNAVAILABLE", "Google did not respond");
    });
    const run = await runNow(ports, schedule);
    const job = { workspaceId: WS, scheduleRunId: run.id };
    await expect(executeRun(ports, { ...job, attempt: 1 })).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
    });
    expect(store.runs[0]!.status).toBe("queued");
    expect(await executeRun(ports, { ...job, attempt: 3 })).toBe("failed");
  });

  it("does not retry permanent failures", async () => {
    const { ports, schedule } = setup(async () => {
      throw new AppError("CAPABILITY_UNAVAILABLE", "Nothing connected");
    });
    const run = await runNow(ports, schedule);
    expect(await executeRun(ports, { workspaceId: WS, scheduleRunId: run.id, attempt: 1 })).toBe(
      "failed",
    );
  });

  it("revalidates ownership and workspace at run time", async () => {
    const { ports, schedule, store, handle } = setup();
    const run = await runNow(ports, schedule);
    // Another workspace cannot execute this run.
    expect(
      await executeRun(ports, {
        workspaceId: "22222222-2222-4222-8222-222222222222",
        scheduleRunId: run.id,
        attempt: 1,
      }),
    ).toBe("failed");
    store.members.clear();
    expect(await executeRun(ports, { workspaceId: WS, scheduleRunId: run.id, attempt: 1 })).toBe(
      "failed",
    );
    expect(handle).not.toHaveBeenCalled();
  });

  it("a scheduled run of a schedule paused meanwhile does not execute", async () => {
    const { ports, schedule, store, handle } = setup();
    await dispatchDue(ports);
    schedule.status = "paused";
    expect(
      await executeRun(ports, { workspaceId: WS, scheduleRunId: store.runs[0]!.id, attempt: 1 }),
    ).toBe("cancelled");
    expect(handle).not.toHaveBeenCalled();
  });

  it("pauses for approval and finishes once the user decides", async () => {
    const { ports, schedule, store } = setup(async () => ({
      kind: "waiting_for_approval",
      approvalId: "approval-1",
    }));
    const run = await runNow(ports, schedule);
    expect(await executeRun(ports, { workspaceId: WS, scheduleRunId: run.id, attempt: 1 })).toBe(
      "waiting_for_approval",
    );
    expect(store.notifications.has(`${run.id}:schedule.approval_requested`)).toBe(true);
    await resumeAfterApproval(ports, "approval-1", { approved: true, succeeded: true });
    expect(store.runs[0]!.status).toBe("completed");
  });
});

describe("Morning Brief assembly", () => {
  const now = new Date("2026-09-29T10:30:00Z"); // 07:30 in Buenos Aires
  const event = (title: string, start: string, end: string): CalendarEvent => ({
    id: title,
    calendarId: "c",
    calendarName: "Work",
    title,
    description: null,
    location: null,
    start,
    end,
    allDay: false,
    attendees: [],
    status: "confirmed",
    url: null,
    provenance: {
      providerKey: "google",
      connectionId: "x",
      externalId: title,
      source: "Northwind",
    },
  });

  it("ranks, filters and explains deterministically, keeping provenance", () => {
    const brief = assembleBrief({
      now,
      timezone: BA,
      events: [
        event("Standup", "2026-09-29T12:00:00Z", "2026-09-29T12:30:00Z"),
        event("Client call", "2026-09-29T12:15:00Z", "2026-09-29T13:00:00Z"),
      ],
      unread: [
        {
          id: "m1",
          threadId: "t1",
          from: { email: "alex@client.com", name: "Alex" },
          to: [],
          cc: [],
          replyTo: [],
          subject: "Contract",
          snippet: "Please sign",
          date: "2026-09-29T09:00:00Z",
          unread: true,
          inInbox: true,
          important: true,
          fromMe: false,
          category: "primary",
          labels: [],
          attachments: [],
          bulk: false,
          body: null,
          rfcMessageId: null,
          references: null,
          url: null,
          provenance: {
            providerKey: "google",
            connectionId: "x",
            externalId: "m1",
            source: "Northwind",
            account: null,
          },
        },
        {
          id: "m2",
          threadId: "t2",
          from: { email: "news@shop.com", name: "Shop" },
          to: [],
          cc: [],
          replyTo: [],
          subject: "Sale!",
          snippet: "",
          date: "2026-09-29T09:30:00Z",
          unread: true,
          inInbox: true,
          important: false,
          fromMe: false,
          category: "promotions",
          labels: [],
          attachments: [],
          bulk: true,
          body: null,
          rfcMessageId: null,
          references: null,
          url: null,
          provenance: {
            providerKey: "google",
            connectionId: "x",
            externalId: "m2",
            source: "Personal",
            account: null,
          },
        },
      ],
      tasks: [
        {
          id: "a",
          title: "Send proposal",
          description: null,
          notes: null,
          status: "pending",
          priority: null,
          category: null,
          dueDate: "2026-09-29",
          completedAt: null,
          createdAt: "",
          updatedAt: "",
          provenance: {
            providerKey: "elise_native",
            connectionId: "n",
            externalId: "a",
            source: "ELISE",
          },
        },
        {
          id: "b",
          title: "Pay invoice",
          description: null,
          notes: null,
          status: "pending",
          priority: null,
          category: null,
          dueDate: "2026-09-25",
          completedAt: null,
          createdAt: "",
          updatedAt: "",
          provenance: {
            providerKey: "google",
            connectionId: "g",
            externalId: "b",
            source: "Personal",
          },
        },
      ],
      warnings: [{ block: "needs_reply", code: "AUTH_EXPIRED" }],
    });
    expect(brief.date).toBe("2026-09-29");
    expect(brief.today?.events.map((e) => [e.title, e.source])).toEqual([
      ["Standup", "Northwind"],
      ["Client call", "Northwind"],
    ]);
    expect(brief.today?.conflicts).toEqual([{ a: "Standup", b: "Client call" }]);
    expect(brief.attention.emails.map((e) => e.subject)).toEqual(["Contract"]); // newsletter dropped
    expect(brief.attention.tasks.map((t) => t.title)).toEqual(["Send proposal"]);
    expect(brief.waitingOnYou.overdue.map((t) => [t.title, t.source])).toEqual([
      ["Pay invoice", "Personal"],
    ]);
    // Follow-ups are Email: one line, with what it means for the user.
    expect(brief.warnings).toEqual([
      { block: "email", code: "AUTH_EXPIRED", state: "auth_expired" },
    ]);
  });
});

describe("proposing a schedule from chat", () => {
  it("returns a structured proposal and creates nothing", async () => {
    const { ports } = makePorts([]);
    const out = await executeToolCall(ports, makeCtx(), {
      name: "schedules.propose",
      args: { days: [1, 2, 3, 4, 5], time: "07:30" },
    });
    expect(out).toMatchObject({
      status: "succeeded",
      display: {
        kind: "schedule_proposal",
        input: {
          name: "Morning Brief",
          timezone: BA,
          definition: { kind: "weekly", days: [1, 2, 3, 4, 5], time: "07:30" },
        },
        // Tuesday 12:00 local → next is Wednesday 07:30 local.
        nextRunAt: "2026-09-30T10:30:00.000Z",
      },
    });
  });
});

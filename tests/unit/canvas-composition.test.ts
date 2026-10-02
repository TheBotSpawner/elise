import { describe, expect, it } from "vitest";

import { applyOps, emptyWorkspace, type Surface, type SurfaceDraft } from "@/core/workspace/model";
import { draftDefaults, type SurfacePayloads } from "@/core/workspace/registry";
import {
  deviceFor,
  resolveComposition,
  temporalItems,
  type CanvasInput,
} from "@/features/workspace/canvas/composition";

/** The Composition Resolver (ADR-021): same state + same screen → same canvas. */

const AT = "2026-10-02T12:00:00.000Z";
const NOW = Date.parse(AT);

const summary = { sections: [{ kind: "facts" as const, heading: "F", items: ["x"] }] };
const meeting: SurfacePayloads["meeting"] = {
  eventId: "e",
  title: "Proposal review",
  start: "2026-10-02T15:00:00Z",
  end: "2026-10-02T16:00:00Z",
  allDay: false,
  status: "confirmed",
  location: null,
  description: null,
  calendarName: "Work",
  account: "Work",
  htmlUrl: null,
  meetingUrl: null,
  attendees: [],
};
const emails: SurfacePayloads["email_list"] = {
  items: ["2026-09-28T10:00:00Z", "2026-09-30T10:00:00Z"].map((date, i) => ({
    messageId: `m${i}`,
    threadId: `t${i}`,
    subject: `Email ${i}`,
    from: { name: "Alex", email: "a@x.test" },
    date,
    snippet: "",
    unread: false,
    account: "Work",
  })),
};
const kpi: SurfacePayloads["visualization"] = {
  spec: { type: "kpi", title: "Spent", format: { kind: "number" }, value: 10, goodWhen: "down" },
};
const bars: SurfacePayloads["visualization"] = {
  spec: {
    type: "hbar",
    title: "Where",
    format: { kind: "number" },
    rows: [{ label: "A", value: 1 }],
  },
};

function s(
  id: string,
  type: Surface["type"],
  payload: unknown,
  over: Partial<SurfaceDraft> = {},
): SurfaceDraft {
  return {
    id,
    type,
    title: id,
    state: "ready",
    source: null,
    ref: null,
    payload,
    intentId: null,
    ...draftDefaults(type, payload as never),
    ...over,
  };
}

function input(
  drafts: SurfaceDraft[],
  over: Partial<CanvasInput> = {},
  ops = [] as never[],
): CanvasInput {
  const state = applyOps(emptyWorkspace(), [
    ...drafts.map((surface, i) => ({
      op: "present" as const,
      surface,
      at: `2026-10-02T12:0${i}:00.000Z`,
    })),
    ...ops,
  ]);
  return {
    state,
    device: "desktop",
    hasMessages: true,
    running: false,
    activeSteps: 0,
    now: NOW,
    ...over,
  };
}

const zones = (c: ReturnType<typeof resolveComposition>) =>
  Object.fromEntries(c.slots.map((x) => [x.id, x.zone]));

describe("composition resolver", () => {
  it("idle, conversation and gathering when there is nothing to show", () => {
    expect(resolveComposition(input([], { hasMessages: false })).kind).toBe("idle");
    expect(resolveComposition(input([], { hasMessages: false })).orb).toBe("hero");
    expect(resolveComposition(input([])).kind).toBe("conversation");
    expect(resolveComposition(input([], { running: true, activeSteps: 2 })).kind).toBe("gathering");
  });

  it("is deterministic", () => {
    const i = input([
      s("m", "meeting", meeting),
      s("e", "email_list", emails),
      s("b", "summary", summary),
    ]);
    expect(resolveComposition(i)).toEqual(resolveComposition(i));
  });

  it("brief: a clear lead, its summary under it, compact Surfaces in the rail", () => {
    const c = resolveComposition(
      input([
        s("m", "meeting", meeting),
        s("e", "email_list", emails),
        s("b", "summary", summary),
        s("p", "person", {
          name: "Alex",
          email: "a@x.test",
          role: "attendee",
          lastEmailAt: null,
          threads: 1,
        }),
      ]),
    );
    expect(c.kind).toBe("brief");
    expect(c.primaryId).toBe("m");
    expect(zones(c)).toMatchObject({ m: "main", b: "main", e: "side", p: "rail" });
    expect(c.slots[0]).toMatchObject({ id: "m", size: "large", tier: "primary" });
    expect(c.orb).toBe("dock");
  });

  it("spatial: several sources without a lead put ELISE at the centre", () => {
    const c = resolveComposition(
      input([
        s("e1", "email_list", emails, { priority: 60 }),
        s("e2", "email_list", emails, { priority: 59 }),
        s("e3", "email_list", emails, { priority: 58 }),
      ]),
    );
    expect(c.kind).toBe("spatial");
    expect(c.orb).toBe("center");
    expect(zones(c)).toEqual({ e1: "left", e3: "left", e2: "right" });
  });

  it("a headline number sits beside its chart instead of leading", () => {
    const c = resolveComposition(
      input([
        s("k", "visualization", kpi, { priority: 76 }),
        s("h", "visualization", bars, { priority: 62 }),
        s("t", "visualization", bars, { priority: 60 }),
      ]),
    );
    expect(c.kind).toBe("brief");
    expect(c.primaryId).toBe("h");
    expect(zones(c).k).toBe("rail");
  });

  it("focus: one Surface leads, the rest shrink to the rails, pinned ones keep content", () => {
    const c = resolveComposition(
      input(
        [s("m", "meeting", meeting), s("e", "email_list", emails), s("b", "summary", summary)],
        {},
        [
          { op: "pin", id: "m", pinned: true, at: AT },
          { op: "focus", id: "e", at: AT },
        ] as never,
      ),
    );
    expect(c.kind).toBe("focus");
    expect(c.slots[0]).toMatchObject({ id: "e", zone: "focus", size: "focus" });
    expect(c.slots.find((x) => x.id === "m")).toMatchObject({ zone: "railRight", size: "small" });
    expect(c.slots.find((x) => x.id === "b")?.size).toBe("micro");
    // Back: the same Surfaces return to the same brief.
    const back = resolveComposition(
      input(
        [s("m", "meeting", meeting), s("e", "email_list", emails), s("b", "summary", summary)],
        {},
        [
          { op: "pin", id: "m", pinned: true, at: AT },
          { op: "focus", id: "e", at: AT },
          { op: "focus", id: null, at: AT },
        ] as never,
      ),
    );
    expect(back.kind).toBe("brief");
    expect(new Set(back.slots.map((x) => x.id))).toEqual(new Set(["m", "e", "b"]));
  });

  it("comparison: two compared Surfaces side by side", () => {
    const c = resolveComposition(
      input(
        [s("a", "summary", summary), s("b", "summary", summary), s("m", "meeting", meeting)],
        {},
        [{ op: "focus", id: "a", compareWith: "b", at: AT }] as never,
      ),
    );
    expect(c.kind).toBe("comparison");
    expect(c.slots.filter((x) => x.zone === "compare").map((x) => x.id)).toEqual(["a", "b"]);
  });

  it("temporal when arranged in time and there are enough dated items; otherwise not", () => {
    const arranged = [{ op: "arrange", order: "time", at: AT }] as never;
    const c = resolveComposition(
      input(
        [s("m", "meeting", meeting), s("e", "email_list", emails), s("b", "summary", summary)],
        {},
        arranged,
      ),
    );
    expect(c.kind).toBe("temporal");
    expect(c.timeline.map((t) => t.title)).toEqual(["Email 0", "Email 1", "Proposal review"]);
    expect(c.timeline.at(-1)?.upcoming).toBe(true);
    expect(zones(c).b).toBe("railRight");
    const few = resolveComposition(
      input([s("m", "meeting", meeting), s("b", "summary", summary)], {}, arranged),
    );
    expect(few.kind).not.toBe("temporal");
  });

  it("a pending approval comes first; the workspace behind it stays, dimmed", () => {
    const approval = s(
      "ap",
      "approval",
      { approvalId: "x", summary: "Send", reason: "send", tool: "email.send", decision: null },
      { state: "attention" },
    );
    const c = resolveComposition(
      input([s("m", "meeting", meeting), s("e", "email_list", emails), approval]),
    );
    expect(c.approvalId).toBe("ap");
    expect(c.slots.every((x) => x.tier === "dim")).toBe(true);
    expect(c.slots.some((x) => x.id === "ap")).toBe(false);
  });

  it("small screens never position: phones stack, overflow goes to the shelf, focus is full screen", () => {
    const drafts = [
      s("m", "meeting", meeting),
      s("b", "summary", summary),
      s("e1", "email_list", emails),
      s("e2", "email_list", emails),
      s("e3", "email_list", emails),
    ];
    const phone = resolveComposition(input(drafts, { device: "mobile" }));
    expect(phone.slots.every((x) => x.zone === "main" || x.zone === "stack")).toBe(true);
    expect(phone.slots.length + phone.shelf.length).toBe(drafts.length);
    const tablet = resolveComposition(input(drafts, { device: "tablet" }));
    expect(tablet.slots.some((x) => x.zone === "rail")).toBe(false);
    expect(tablet.slots.length + tablet.shelf.length).toBe(drafts.length);
    const focused = resolveComposition(
      input(drafts, { device: "mobile" }, [{ op: "focus", id: "e1", at: AT }] as never),
    );
    expect(focused.slots).toHaveLength(1);
    expect(focused.shelf).toHaveLength(drafts.length - 1);
  });

  it("transient confirmations never take a slot; arriving Surfaces are marked while the turn runs", () => {
    const c = resolveComposition(
      input([s("m", "meeting", meeting), s("set", "summary", summary, { transient: true })], {
        running: true,
      }),
    );
    expect(c.slots.map((x) => x.id)).toEqual(["m"]);
    const two = resolveComposition(
      input([s("m", "meeting", meeting), s("e", "email_list", emails)], { running: true }),
    );
    expect(two.slots.find((x) => x.id === "e")?.tier).toBe("arriving");
  });

  it("device classes and dated items", () => {
    expect([360, 800, 1440, 2560].map(deviceFor)).toEqual(["mobile", "tablet", "desktop", "wide"]);
    const state = applyOps(emptyWorkspace(), [
      { op: "present", surface: s("e", "email_list", emails), at: AT },
    ]);
    expect(temporalItems(state.surfaces, NOW).map((t) => t.item)).toEqual(["t0", "t1"]);
  });
});

describe("motion", () => {
  it("reduced motion keeps meaning without movement: fades only, no travel or scale", async () => {
    const { surfaceMotion } = await import("@/features/workspace/canvas/motion");
    const reduced = surfaceMotion(true);
    expect(reduced.initial).toEqual({ opacity: 0 });
    expect(JSON.stringify(reduced)).not.toMatch(/"y"|scale/);
    expect(surfaceMotion(false).initial).toMatchObject({ y: 12 });
  });
});

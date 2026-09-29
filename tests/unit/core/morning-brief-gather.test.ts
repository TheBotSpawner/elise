import { describe, expect, it } from "vitest";

import { gatherBrief } from "@/application/morning-brief-service";
import type { CalendarProvider } from "@/core/capabilities/calendar";
import { AppError } from "@/core/errors";
import { morningBriefConfigSchema } from "@/core/schedules/schedule";

import {
  binding,
  InMemoryEmailProvider,
  InMemoryTaskProvider,
  makeCtx,
  makePorts,
  NATIVE_BINDING,
} from "../../fixtures/core-fakes";

const PERSONAL = "11111111-1111-4111-8111-111111111111";
const FIRBOT = "22222222-2222-4222-8222-222222222222";

const calendar = (events: number): CalendarProvider =>
  ({
    listEvents: async () =>
      Array.from({ length: events }, (_, i) => ({
        id: `e${i}`,
        calendarId: "c",
        calendarName: "Work",
        title: `Meeting ${i}`,
        description: null,
        location: null,
        start: "2026-09-29T13:00:00Z",
        end: "2026-09-29T14:00:00Z",
        allDay: false,
        attendees: [],
        status: "confirmed",
        url: null,
        provenance: {
          providerKey: "google",
          connectionId: PERSONAL,
          externalId: `e${i}`,
          source: "Personal",
        },
      })),
  }) as unknown as CalendarProvider;

function setup(opts: { firbotStatus?: "connected" | "needs_reauthorization" } = {}) {
  const personalMail = new InMemoryEmailProvider(PERSONAL, "Personal", "leo@gmail.com");
  const firbotMail = new InMemoryEmailProvider(FIRBOT, "Firbot", "leo@firbot.com");
  const tasks = new InMemoryTaskProvider();
  const cal = calendar(2);
  const providers = new Map<string, Record<string, unknown>>([
    [PERSONAL, { email: personalMail, calendar: cal }],
    [FIRBOT, { email: firbotMail }],
    ["conn-native", { tasks }],
  ]);
  const bindings = [
    NATIVE_BINDING,
    binding({
      connectionId: PERSONAL,
      capability: "calendar",
      providerKey: "google",
      label: "Personal",
    }),
    binding({
      connectionId: PERSONAL,
      capability: "email",
      providerKey: "google",
      label: "Personal",
      isDefault: true,
    }),
    binding({
      connectionId: FIRBOT,
      capability: "email",
      providerKey: "google",
      label: "Firbot",
      connectionStatus: opts.firbotStatus ?? "connected",
    }),
  ];
  const { ports } = makePorts(bindings);
  ports.providers = {
    get: ((capability: string, b: { connectionId: string }) =>
      providers.get(b.connectionId)?.[capability]) as typeof ports.providers.get,
  };
  const ctx = makeCtx({ origin: "schedule", now: new Date("2026-09-29T10:30:00Z") });
  return { ports, ctx, personalMail, firbotMail, tasks };
}

const all = morningBriefConfigSchema.parse({});

describe("Morning Brief gathering", () => {
  it("reads calendar, email and tasks across the accounts connected right now", async () => {
    const { ports, ctx, personalMail, firbotMail, tasks } = setup();
    personalMail.addMessage({ id: "p1", threadId: "pt1" });
    firbotMail.addMessage({ id: "f1", threadId: "ft1" });
    await tasks.create({ title: "Send proposal", dueDate: "2026-09-29" });
    const { data, failed } = await gatherBrief(ports, ctx, all);
    expect(failed).toBe(0);
    expect(data.events).toHaveLength(2);
    expect(data.unread?.map((m) => m.provenance.source).sort()).toEqual(["Firbot", "Personal"]);
    expect(data.tasks?.map((t) => t.title)).toEqual(["Send proposal"]);
    expect(data.warnings).toEqual([]);
  });

  it("keeps the brief when one source fails and says which", async () => {
    const { ports, ctx, firbotMail, personalMail } = setup();
    personalMail.failReads = new AppError("AUTH_EXPIRED", "reconnect");
    firbotMail.failReads = new AppError("AUTH_EXPIRED", "reconnect");
    const { data, failed, attempted } = await gatherBrief(ports, ctx, all);
    expect(failed).toBe(3); // email + two follow-up reads
    expect(attempted).toBe(5);
    expect(data.events).toHaveLength(2);
    expect(data.warnings.map((w) => [w.block, w.code])).toContainEqual(["email", "AUTH_EXPIRED"]);
  });

  it("skips an account that needs reconnecting and names it, instead of failing", async () => {
    const { ports, ctx, personalMail } = setup({ firbotStatus: "needs_reauthorization" });
    personalMail.addMessage({ id: "p1", threadId: "pt1" });
    const { data } = await gatherBrief(ports, ctx, all);
    expect(data.unread?.map((m) => m.provenance.source)).toEqual(["Personal"]);
  });

  it("a pinned account is used alone and never replaced by another", async () => {
    const { ports, ctx, personalMail } = setup({ firbotStatus: "needs_reauthorization" });
    personalMail.addMessage({ id: "p1", threadId: "pt1" });
    const pinned = morningBriefConfigSchema.parse({
      blocks: ["email"],
      sources: { email: FIRBOT },
    });
    const { data } = await gatherBrief(ports, ctx, pinned);
    expect(data.unread).toBeUndefined();
    expect(data.warnings).toEqual([{ block: "email", code: "AUTH_EXPIRED" }]);
  });
});

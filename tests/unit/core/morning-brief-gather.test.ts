import { describe, expect, it } from "vitest";

import { gatherBrief } from "@/application/morning-brief-service";
import { assembleBrief, briefIssues, sourceState } from "@/core/briefs/morning-brief";
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
const NORTHWIND = "22222222-2222-4222-8222-222222222222";

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

function setup(opts: { northwindStatus?: "connected" | "needs_reauthorization" } = {}) {
  const personalMail = new InMemoryEmailProvider(PERSONAL, "Personal", "leo@gmail.com");
  const northwindMail = new InMemoryEmailProvider(NORTHWIND, "Northwind", "leo@northwind.com");
  const tasks = new InMemoryTaskProvider();
  const cal = calendar(2);
  const providers = new Map<string, Record<string, unknown>>([
    [PERSONAL, { email: personalMail, calendar: cal }],
    [NORTHWIND, { email: northwindMail }],
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
      connectionId: NORTHWIND,
      capability: "email",
      providerKey: "google",
      label: "Northwind",
      connectionStatus: opts.northwindStatus ?? "connected",
    }),
  ];
  const { ports } = makePorts(bindings);
  ports.providers = {
    get: ((capability: string, b: { connectionId: string }) =>
      providers.get(b.connectionId)?.[capability]) as typeof ports.providers.get,
  };
  const ctx = makeCtx({ origin: "schedule", now: new Date("2026-09-29T10:30:00Z") });
  return { ports, ctx, personalMail, northwindMail, tasks };
}

const all = morningBriefConfigSchema.parse({
  blocks: ["calendar", "email", "needs_reply", "tasks"],
});

describe("Morning Brief gathering", () => {
  it("reads calendar, email and tasks across the accounts connected right now", async () => {
    const { ports, ctx, personalMail, northwindMail, tasks } = setup();
    personalMail.addMessage({ id: "p1", threadId: "pt1" });
    northwindMail.addMessage({ id: "f1", threadId: "ft1" });
    await tasks.create({ title: "Send proposal", dueDate: "2026-09-29" });
    const { data, failed } = await gatherBrief(ports, ctx, all);
    expect(failed).toBe(0);
    expect(data.events).toHaveLength(2);
    expect(data.unread?.map((m) => m.provenance.source).sort()).toEqual(["Northwind", "Personal"]);
    expect(data.tasks?.map((t) => t.title)).toEqual(["Send proposal"]);
    expect(data.warnings).toEqual([]);
  });

  it("keeps the brief when one source fails and says which", async () => {
    const { ports, ctx, northwindMail, personalMail } = setup();
    personalMail.failReads = new AppError("AUTH_EXPIRED", "reconnect");
    northwindMail.failReads = new AppError("AUTH_EXPIRED", "reconnect");
    const { data, failed, attempted } = await gatherBrief(ports, ctx, all);
    expect(failed).toBe(3); // email + two follow-up reads
    expect(attempted).toBe(5);
    expect(data.events).toHaveLength(2);
    expect(data.warnings.map((w) => [w.block, w.code])).toContainEqual(["email", "AUTH_EXPIRED"]);
  });

  it("skips an account that needs reconnecting and names it, instead of failing", async () => {
    const { ports, ctx, personalMail } = setup({ northwindStatus: "needs_reauthorization" });
    personalMail.addMessage({ id: "p1", threadId: "pt1" });
    const { data } = await gatherBrief(ports, ctx, all);
    expect(data.unread?.map((m) => m.provenance.source)).toEqual(["Personal"]);
  });

  it("a pinned account is used alone and never replaced by another", async () => {
    const { ports, ctx, personalMail } = setup({ northwindStatus: "needs_reauthorization" });
    personalMail.addMessage({ id: "p1", threadId: "pt1" });
    const pinned = morningBriefConfigSchema.parse({
      blocks: ["email"],
      sources: { email: NORTHWIND },
    });
    const { data } = await gatherBrief(ports, ctx, pinned);
    expect(data.unread).toBeUndefined();
    expect(data.warnings).toEqual([{ block: "email", code: "AUTH_EXPIRED" }]);
  });
});

describe("Morning Brief connection semantics", () => {
  it("an empty inbox is an empty section, not a disconnected source", async () => {
    const { ports, ctx } = setup();
    const { data } = await gatherBrief(ports, ctx, all);
    expect(data.unread).toEqual([]);
    expect(briefIssues(data.warnings)).toEqual([]);
  });

  it("a worker missing Google secrets is a setup problem, never 'not connected'", async () => {
    const { ports, ctx, personalMail, northwindMail } = setup();
    const missing = new AppError("SERVER_NOT_CONFIGURED", "Google connections are not configured");
    personalMail.failReads = missing;
    northwindMail.failReads = missing;
    const { data } = await gatherBrief(ports, ctx, all);
    const issues = briefIssues(data.warnings);
    // email + needs_reply + waiting_on_others collapse into one Email line.
    expect(issues).toEqual([
      { block: "email", code: "SERVER_NOT_CONFIGURED", state: "server_config" },
    ]);
    expect(issues.some((w) => w.state === "no_connection")).toBe(false);
  });

  it("expired auth asks to reconnect; a provider error says it failed — neither is 'not connected'", () => {
    expect(sourceState("AUTH_EXPIRED")).toBe("auth_expired");
    expect(sourceState("PROVIDER_UNAVAILABLE")).toBe("temporary");
    expect(sourceState("INTERNAL_ERROR")).toBe("provider_error");
    expect(sourceState("CAPABILITY_UNAVAILABLE")).toBe("no_connection");
  });

  it("one line per source: four news topics fail once, accounts are listed on one line", () => {
    const issues = briefIssues([
      ...["a", "b", "c", "d"].map(() => ({ block: "news", code: "SERVER_NOT_CONFIGURED" })),
      { block: "tasks", code: "AUTH_EXPIRED", account: "Personal" },
      { block: "tasks", code: "AUTH_EXPIRED", account: "UTN" },
      { block: "tasks", code: "AUTH_EXPIRED", account: "Personal" },
      { block: "summary", code: "AI_NOT_CONFIGURED" },
    ]);
    expect(issues).toEqual([
      { block: "news", code: "SERVER_NOT_CONFIGURED", state: "server_config" },
      {
        block: "tasks",
        code: "AUTH_EXPIRED",
        state: "auth_expired",
        accounts: ["Personal", "UTN"],
      },
      { block: "summary", code: "AI_NOT_CONFIGURED" },
    ]);
    // Briefs stored before this keep working: deduplicating twice changes nothing.
    expect(briefIssues(issues)).toEqual(issues);
  });

  it("a whole-source failure doesn't also list its accounts", () => {
    const issues = briefIssues([
      { block: "calendar", code: "AUTH_EXPIRED", account: "Personal" },
      { block: "calendar", code: "AUTH_EXPIRED" },
    ]);
    expect(issues).toEqual([{ block: "calendar", code: "AUTH_EXPIRED", state: "auth_expired" }]);
  });

  it("resolves connections when it runs: an account connected after the schedule is used", async () => {
    const { ports, ctx, personalMail } = setup();
    personalMail.addMessage({ id: "p1", threadId: "pt1" });
    const email = morningBriefConfigSchema.parse({ blocks: ["email"] });
    // Before: no email account at all.
    const before = { ...ports, loadBindings: async () => [NATIVE_BINDING] };
    const first = await gatherBrief(before, ctx, email);
    expect(briefIssues(first.data.warnings)).toMatchObject([
      { block: "email", state: "no_connection" },
    ]);
    // Same schedule configuration, next run: Gmail is now connected.
    const second = await gatherBrief(ports, ctx, email);
    expect(second.data.unread?.map((m) => m.provenance.source)).toContain("Personal");
    expect(second.data.warnings).toEqual([]);
  });

  it("a removed connection stops being read on the next run", async () => {
    const { ports, ctx, personalMail, northwindMail } = setup();
    personalMail.addMessage({ id: "p1", threadId: "pt1" });
    northwindMail.addMessage({ id: "f1", threadId: "ft1" });
    const email = morningBriefConfigSchema.parse({ blocks: ["email"] });
    const removed = {
      ...ports,
      loadBindings: async () =>
        (await ports.loadBindings()).filter((b) => b.connectionId !== PERSONAL),
    };
    const { data } = await gatherBrief(removed, ctx, email);
    expect(data.unread?.map((m) => m.provenance.source)).toEqual(["Northwind"]);
  });

  it("news needs topics, not a connection", async () => {
    const { ports, ctx } = setup();
    const news = morningBriefConfigSchema.parse({ blocks: ["news"] });
    const { data } = await gatherBrief(ports, ctx, news);
    expect(briefIssues(data.warnings)).toEqual([
      { block: "news", code: "NEEDS_TOPICS", state: "needs_topics" },
    ]);
  });

  it("weather comes from the structured forecast and lands in the assembled brief", async () => {
    const { ports, ctx } = setup();
    const calls: unknown[] = [];
    const weather = {
      attribution: { name: "Open-Meteo", url: "https://open-meteo.com/" },
      geocode: async (name: string) => {
        calls.push(name);
        return [{ name, detail: null, lat: -34.6, lng: -58.38 }];
      },
      forecast: async () => ({
        timezone: "America/Argentina/Buenos_Aires",
        current: null,
        daily: [
          {
            date: "2026-09-29",
            condition: "rain" as const,
            min: 18,
            max: 25,
            precipitationProbability: 70,
            precipitationSum: 4,
            windMax: 10,
            sunrise: null,
            sunset: null,
          },
        ],
        hourly: [
          {
            time: "2026-09-29T18:00",
            temperature: 20,
            condition: "rain" as const,
            precipitationProbability: 70,
            windSpeed: 10,
            isDay: true,
          },
        ],
      }),
    };
    const get = ports.providers.get;
    ports.providers = {
      get: ((c: string, b: never) =>
        c === "weather" ? weather : get(c as never, b)) as typeof get,
    };
    const config = morningBriefConfigSchema.parse({ blocks: ["calendar", "weather"] });
    const { data } = await gatherBrief(ports, ctx, config);
    expect(calls).toEqual(["Buenos Aires"]);
    const brief = assembleBrief(data);
    expect(brief.weather?.days[0]).toMatchObject({ min: 18, max: 25 });
    expect(brief.today?.events).toHaveLength(2);
    expect(brief.warnings).toEqual([]);
  });
});

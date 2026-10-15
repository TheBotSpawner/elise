import { describe, expect, it } from "vitest";

import { gatherBrief } from "@/application/morning-brief-service";
import { executeApprovedAction, executeToolCall } from "@/core/agents/executor";
import { toolNotes } from "@/core/agents/runtime";
import { selectTools, toolsInNotes } from "@/core/agents/tool-selection";
import type { ToolDisplay } from "@/core/agents/tools";
import { assembleBrief, briefTopics } from "@/core/briefs/morning-brief";
import {
  searchWindow,
  type TeamAccess,
  type TeamChannel,
  type TeamMessage,
  type TeamMessagingProvider,
  type TeamPerson,
  type TeamSearchQuery,
} from "@/core/capabilities/team-messaging";
import { AppError } from "@/core/errors";
import { makeExternalRef } from "@/core/providers/refs";
import { morningBriefConfigSchema, previousOccurrence } from "@/core/schedules/schedule";
import { teamDisplayForStorage, TEAM_MESSAGING_TOOLS } from "@/core/tools/team-messaging";
import { surfacesFromOutcome } from "@/core/workspace/from-results";
import { applyOps, emptyWorkspace, type WorkspaceOp } from "@/core/workspace/model";

import { binding, makeCtx, makePorts } from "../../fixtures/core-fakes";

/**
 * Team Messaging (ADR-062) through the canonical path: one workspace unless asked for all,
 * live search with provenance, writes pinned to the exact approved text and destination, one
 * Slack Surface that updates, and a bounded Slack block in the brief.
 */

const FIRBOT = "11111111-aaaa-4aaa-8aaa-111111111111";
const LARREA = "22222222-bbbb-4bbb-8bbb-222222222222";
const tz = "America/Argentina/Buenos_Aires";

class FakeTeam implements TeamMessagingProvider {
  posts: { to: string; text: string; threadId: string | null }[] = [];
  reactions: { id: string; emoji: string; on: boolean }[] = [];
  searches: TeamSearchQuery[] = [];
  reads: { channel: string; after?: Date }[] = [];
  constructor(
    private readonly conn: string,
    private readonly name: string,
    private readonly granted: TeamAccess[] = ["public", "people", "send", "reactions"],
    private readonly people: { id: string; name: string; handle: string }[] = [
      { id: "U1", name: "Rod Díaz", handle: "rod" },
      { id: "U2", name: "Martín Pérez", handle: "martin.p" },
      { id: "U3", name: "Martín Gómez", handle: "martin.g" },
    ],
  ) {}
  private prov() {
    return {
      providerKey: "slack" as const,
      connectionId: this.conn,
      source: this.name,
      workspace: this.name,
    };
  }
  msg(ts: string, text: string, channel = "C1"): TeamMessage {
    return {
      id: makeExternalRef(this.conn, "m", channel, ts),
      threadId: makeExternalRef(this.conn, "t", channel, ts),
      channel: { id: makeExternalRef(this.conn, "c", channel), name: "firbot-dev", kind: "public" },
      author: { id: null, name: "Juan", avatar: null, bot: false },
      text,
      date: new Date(Number(ts) * 1000).toISOString(),
      replyCount: 1,
      files: [],
      url: `https://${this.name.toLowerCase()}.slack.com/archives/${channel}/p${ts.replace(".", "")}`,
      provenance: this.prov(),
    };
  }
  async access() {
    return this.granted;
  }
  async search(q: TeamSearchQuery) {
    this.searches.push(q);
    return {
      messages: [
        this.msg("1760500000.1", `${this.name}: ${q.text}`),
        this.msg("1760400000.1", "older"),
      ],
      files: [],
      notSearched: (["private", "direct"] as const).filter((a) => !this.granted.includes(a)),
    };
  }
  async listChannels(): Promise<TeamChannel[]> {
    return [
      {
        id: makeExternalRef(this.conn, "c", "C1"),
        name: "firbot-dev",
        kind: "public",
        topic: null,
        url: null,
        provenance: this.prov(),
      },
      {
        id: makeExternalRef(this.conn, "c", "C2"),
        name: "sales",
        kind: "public",
        topic: null,
        url: null,
        provenance: this.prov(),
      },
    ];
  }
  async findPeople(query: string): Promise<TeamPerson[]> {
    const q = query.toLowerCase().replace("@", "").normalize("NFD").replace(/\p{M}/gu, "");
    return this.people
      .filter((p) =>
        (p.name + " " + p.handle).toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").includes(q),
      )
      .map((p) => ({
        id: makeExternalRef(this.conn, "u", p.id),
        name: p.name,
        handle: p.handle,
        title: null,
        avatar: null,
        provenance: this.prov(),
      }));
  }
  async getRecent(channelId: string, w: { after?: Date }) {
    this.reads.push({ channel: channelId, after: w.after });
    return { messages: [this.msg("1760500000.5", "recent news", "C2")], hasMore: false };
  }
  async getThread(ref: string) {
    const root = this.msg("1760400000.1", "root");
    return {
      id: ref,
      channel: root.channel,
      messages: [root, this.msg("1760400001.1", "reply")],
      hasMore: false,
      url: root.url,
      provenance: this.prov(),
    };
  }
  async getMessage(id: string) {
    return { ...this.msg("1760400000.1", "one"), id };
  }
  async destination(ref: string): Promise<TeamChannel> {
    const people = await this.findPeople("");
    const p = people.find((x) => x.id === ref);
    return p
      ? { id: ref, name: p.name, kind: "direct", topic: null, url: null, provenance: this.prov() }
      : ((await this.listChannels()).find((c) => c.id === ref) ?? (await this.listChannels())[0]!);
  }
  async post(input: { to: string; text: string; threadId: string | null }) {
    this.posts.push(input);
    return this.msg("1760600000.1", input.text);
  }
  async react(id: string, emoji: string, on: boolean) {
    this.reactions.push({ id, emoji, on });
  }
}

function setup(opts: { firbotContext?: string; larrea?: boolean } = {}) {
  const firbot = new FakeTeam(FIRBOT, "Firbot");
  const larrea = new FakeTeam(LARREA, "Larrea", ["public", "private", "people", "send"]);
  const team = (
    connectionId: string,
    label: string,
    isDefault: boolean,
    contextLabel: string | null = null,
  ) =>
    binding({
      connectionId,
      capability: "team_messaging",
      providerKey: "slack",
      label,
      accountLabel: `Leo · ${label}`,
      contextLabel,
      isDefault,
    });
  const bindings = [
    team(FIRBOT, "Firbot", true, opts.firbotContext ?? null),
    ...(opts.larrea === false ? [] : [team(LARREA, "Larrea", false)]),
  ];
  const { ports, log } = makePorts(bindings, { [FIRBOT]: firbot, [LARREA]: larrea });
  return { ports, log, firbot, larrea };
}

const call = (
  ports: ReturnType<typeof setup>["ports"],
  name: string,
  args: unknown,
  ctx = makeCtx(),
) => executeToolCall(ports, ctx, { name, args });

describe("time windows", () => {
  const today = "2026-10-15"; // a Thursday
  it("resolves what the user said into exact instants in their timezone", () => {
    expect(searchWindow({ period: "today" }, today, tz)).toEqual({
      after: new Date("2026-10-15T03:00:00Z"),
      before: new Date("2026-10-16T03:00:00Z"),
    });
    expect(searchWindow({ sinceWeekday: "monday" }, today, tz).after).toEqual(
      new Date("2026-10-12T03:00:00Z"),
    );
    expect(searchWindow({ sinceWeekday: "thursday" }, today, tz).after).toEqual(
      new Date("2026-10-15T03:00:00Z"),
    );
    expect(searchWindow({ before: "2026-10-15T10:30" }, today, tz).before).toEqual(
      new Date("2026-10-15T13:30:00Z"),
    );
    expect(searchWindow({ period: "last_month" }, today, tz).after).toEqual(
      new Date("2026-09-01T03:00:00Z"),
    );
  });
});

describe("search and workspace resolution", () => {
  it("several workspaces and none named: ELISE asks instead of searching them all", async () => {
    const { ports, firbot, larrea } = setup();
    const out = await call(ports, "teamMessaging.search", { query: "RSFA" });
    expect(out.status).toBe("clarification_required");
    expect(firbot.searches.length + larrea.searches.length).toBe(0);
  });

  it("the named workspace is the only one searched", async () => {
    const { ports, firbot, larrea } = setup();
    const out = await call(ports, "teamMessaging.search", {
      query: "WhatsApp",
      destination: "Larrea",
      period: "today",
    });
    expect(out.status).toBe("succeeded");
    expect(larrea.searches).toHaveLength(1);
    expect(firbot.searches).toHaveLength(0);
    // "today" reached the provider as exact instants, not words.
    expect(larrea.searches[0]!.after).toEqual(new Date("2026-09-29T03:00:00Z"));
  });

  it("the conversation's context and 'use this workspace for' pick the workspace", async () => {
    const { ports, firbot } = setup({ firbotContext: "Firbot Solutions" });
    const ctx = makeCtx({ context: { id: "s1", name: "Firbot Solutions", kind: "client" } });
    expect((await call(ports, "teamMessaging.search", { query: "chatbot" }, ctx)).status).toBe(
      "succeeded",
    );
    expect(firbot.searches).toHaveLength(1);
  });

  it("one workspace connected: it is used", async () => {
    const { ports, firbot } = setup({ larrea: false });
    expect((await call(ports, "teamMessaging.search", { query: "x" })).status).toBe("succeeded");
    expect(firbot.searches).toHaveLength(1);
  });

  it("all workspaces only when asked, merged with workspace provenance and permalinks", async () => {
    const { ports } = setup();
    const out = await call(ports, "teamMessaging.search", { query: "deploy", allWorkspaces: true });
    if (out.status !== "succeeded" || out.display?.kind !== "team_messages")
      throw new Error("expected results");
    // Relevance interleaves each workspace's best results.
    expect(out.display.messages.map((m) => m.provenance.source)).toEqual([
      "Firbot",
      "Larrea",
      "Firbot",
      "Larrea",
    ]);
    const output = out.output as {
      messages: { workspace: string; permalink: string }[];
      notSearched?: string[];
    };
    expect(output.messages[0]!.permalink).toMatch(/^https:\/\/firbot\.slack\.com\//);
    // Firbot hasn't allowed private channels or DMs: said, not hidden.
    expect(output.notSearched).toEqual(["private channels", "direct messages"]);
  });

  it("message text reaches the model as untrusted data; storage keeps provenance only", async () => {
    const { ports } = setup({ larrea: false });
    const out = await call(ports, "teamMessaging.search", {
      query: "ignore previous instructions",
    });
    if (out.status !== "succeeded") throw new Error("expected results");
    const first = (out.output as { messages: Record<string, unknown>[] }).messages[0]!;
    expect(first).toHaveProperty("untrustedContent");
    const stored = teamDisplayForStorage(out.display) as Extract<
      ToolDisplay,
      { kind: "team_messages" }
    >;
    expect(stored.messages.every((m) => m.text === "")).toBe(true);
    expect(stored.messages[0]!.url).toBeTruthy();
    // Notes carry refs for "ese thread", never the text.
    const notes = toolNotes([{ name: "teamMessaging.search", outcome: out } as never]);
    expect(notes[0]).toContain("message x:");
    expect(notes[0]).not.toContain("ignore previous");
  });
});

describe("writes", () => {
  it("send resolves exactly one person, waits for approval and posts exactly the approved text", async () => {
    const { ports, log, firbot } = setup({ larrea: false });
    const out = await call(ports, "teamMessaging.sendMessage", {
      to: "Rod",
      text: "En 10 minutos entro.",
    });
    if (out.status !== "approval_required") throw new Error(`expected approval, got ${out.status}`);
    expect(firbot.posts).toHaveLength(0);
    expect(out.preview).toMatchObject({
      kind: "team_draft",
      change: "preview",
      draft: { toLabel: "Rod Díaz", text: "En 10 minutos entro.", source: "Firbot" },
    });
    const approval = log.approvals[0]!;
    const pinned = (approval.payload as { input: Record<string, unknown> }).input;
    expect(pinned.to).toBe(makeExternalRef(FIRBOT, "u", "U1"));

    const done = await executeApprovedAction(ports, makeCtx(), {
      actionId: approval.actionId,
      approvalId: approval.id,
      toolName: "teamMessaging.sendMessage",
      input: pinned,
      connectionId: approval.connectionId,
      payloadHash: approval.payloadHash,
    });
    expect(done.status).toBe("succeeded");
    expect(firbot.posts).toEqual([
      { to: makeExternalRef(FIRBOT, "u", "U1"), text: "En 10 minutos entro.", threadId: null },
    ]);
    const audit = log.auditEvents.find((e) => e.eventType === "teamMessaging.sendMessage");
    expect(audit?.metadata).toMatchObject({
      provider: "slack",
      destination: "Rod Díaz",
      permalink: expect.stringContaining("https://"),
    });
    expect(JSON.stringify(audit?.metadata)).not.toContain("10 minutos");
  });

  it("changing the text or destination after approval sends nothing", async () => {
    const { ports, log, firbot } = setup({ larrea: false });
    await call(ports, "teamMessaging.sendMessage", { to: "Rod", text: "Llego tarde." });
    const a = log.approvals[0]!;
    const pinned = (a.payload as { input: Record<string, unknown> }).input;
    const out = await executeApprovedAction(ports, makeCtx(), {
      actionId: a.actionId,
      approvalId: a.id,
      toolName: "teamMessaging.sendMessage",
      input: { ...pinned, text: "Algo distinto" },
      connectionId: a.connectionId,
      payloadHash: a.payloadHash,
    });
    expect(out).toMatchObject({ status: "failed", error: { code: "CONFLICT" } });
    expect(firbot.posts).toHaveLength(0);
  });

  it("two people called Martín: no approval, a question with both", async () => {
    const { ports, log } = setup({ larrea: false });
    const out = await call(ports, "teamMessaging.sendMessage", {
      to: "Martín",
      text: "Llego 15 tarde",
    });
    expect(out).toMatchObject({ status: "failed", error: { code: "VALIDATION_ERROR" } });
    if (out.status === "failed") expect(out.error.message).toMatch(/Martín Pérez.*Martín Gómez/);
    expect(log.approvals).toHaveLength(0);
  });

  it("a channel destination resolves exactly; several workspaces ask which", async () => {
    const two = setup();
    expect(
      (await call(two.ports, "teamMessaging.sendMessage", { to: "#sales", text: "hola" })).status,
    ).toBe("clarification_required");
    const { ports } = setup({ larrea: false });
    const out = await call(ports, "teamMessaging.sendMessage", { to: "#sales", text: "hola" });
    expect(out).toMatchObject({
      status: "approval_required",
      preview: { draft: { toLabel: "#sales" } },
    });
  });

  it("drafting resolves the destination and sends nothing", async () => {
    const { ports, firbot, log } = setup({ larrea: false });
    const out = await call(ports, "teamMessaging.draftMessage", { to: "@rod", text: "Borrador" });
    expect(out).toMatchObject({
      status: "succeeded",
      display: { kind: "team_draft", change: "drafted" },
    });
    expect(firbot.posts).toHaveLength(0);
    expect(log.approvals).toHaveLength(0);
  });

  it("a reply stays in its thread and workspace, after approval", async () => {
    const { ports, log, larrea } = setup();
    const thread = makeExternalRef(LARREA, "t", "C1", "1760400000.1");
    const out = await call(ports, "teamMessaging.reply", { id: thread, text: "Ya quedó resuelto" });
    expect(out.status).toBe("approval_required");
    const a = log.approvals[0]!;
    expect(a.connectionId).toBe(LARREA);
    await executeApprovedAction(ports, makeCtx(), {
      actionId: a.actionId,
      approvalId: a.id,
      toolName: "teamMessaging.reply",
      input: (a.payload as { input: unknown }).input,
      connectionId: a.connectionId,
      payloadHash: a.payloadHash,
    });
    expect(larrea.posts[0]).toMatchObject({ threadId: thread, text: "Ya quedó resuelto" });
  });

  it("a reaction runs right away when allowed; without the permission it says which", async () => {
    const { ports, firbot } = setup();
    const msg = makeExternalRef(FIRBOT, "m", "C1", "1.1");
    expect(
      (await call(ports, "teamMessaging.addReaction", { messageId: msg, emoji: "👍" })).status,
    ).toBe("succeeded");
    expect(firbot.reactions).toEqual([{ id: msg, emoji: "👍", on: true }]);
    const out = await call(ports, "teamMessaging.addReaction", {
      messageId: makeExternalRef(LARREA, "m", "C1", "1.1"),
      emoji: "👍",
    });
    expect(out).toMatchObject({ status: "failed", error: { code: "PERMISSION_DENIED" } });
  });

  it("sending without the send permission fails before any approval", async () => {
    const readOnly = new FakeTeam(FIRBOT, "Firbot", ["public", "people"]);
    const { ports, log } = makePorts(
      [
        binding({
          connectionId: FIRBOT,
          capability: "team_messaging",
          providerKey: "slack",
          label: "Firbot",
        }),
      ],
      { [FIRBOT]: readOnly },
    );
    const out = await call(ports, "teamMessaging.sendMessage", { to: "Rod", text: "x" });
    expect(out).toMatchObject({ status: "failed", error: { code: "PERMISSION_DENIED" } });
    expect(log.approvals).toHaveLength(0);
  });

  it("no tool is provider-named", () => {
    for (const t of TEAM_MESSAGING_TOOLS) expect(t.name).toMatch(/^teamMessaging\./);
  });
});

describe("Live Canvas", () => {
  const present = (state: ReturnType<typeof emptyWorkspace>, d: ToolDisplay, key: string) =>
    applyOps(
      state,
      surfacesFromOutcome("teamMessaging.search", { status: "succeeded", display: d }, { key }).map(
        (surface): WorkspaceOp => ({ op: "present", surface, at: "2026-10-15T12:00:00Z" }),
      ),
    );

  it("one Slack results Surface: a new search replaces it, even with nothing found", async () => {
    const { ports } = setup({ larrea: false });
    const a = await call(ports, "teamMessaging.search", { query: "RSFA" });
    const b = await call(ports, "teamMessaging.search", { query: "WhatsApp" });
    if (a.status !== "succeeded" || b.status !== "succeeded") throw new Error();
    let state = present(emptyWorkspace(), a.display!, "call-1");
    state = present(state, b.display!, "call-2");
    const empty: ToolDisplay = {
      kind: "team_messages",
      query: "nada",
      channel: null,
      messages: [],
      files: [],
      notSearched: [],
    };
    state = present(state, empty, "call-3");
    const slack = state.surfaces.filter((s) => s.type === "team_messages");
    expect(slack).toHaveLength(1);
    expect((slack[0]!.payload as { query: string }).query).toBe("nada");
  });

  it("'mostrame ese thread' is one thread Surface beside the results, updated in place", async () => {
    const { ports } = setup({ larrea: false });
    const search = await call(ports, "teamMessaging.search", { query: "bug" });
    const t1 = await call(ports, "teamMessaging.getThread", {
      id: makeExternalRef(FIRBOT, "t", "C1", "1.1"),
    });
    const t2 = await call(ports, "teamMessaging.getThread", {
      id: makeExternalRef(FIRBOT, "t", "C1", "2.2"),
    });
    if (search.status !== "succeeded" || t1.status !== "succeeded" || t2.status !== "succeeded")
      throw new Error();
    let state = present(emptyWorkspace(), search.display!, "c1");
    state = present(state, t1.display!, "c2");
    state = present(state, t2.display!, "c3");
    expect(state.surfaces.map((s) => s.type).sort()).toEqual(["team_messages", "team_thread"]);
    const thread = state.surfaces.find((s) => s.type === "team_thread")!;
    expect((thread.payload as { threadId: string }).threadId).toBe(
      makeExternalRef(FIRBOT, "t", "C1", "2.2"),
    );
  });
});

describe("tool selection", () => {
  it("Slack words bring the team tools; recent camelCase tools are remembered", () => {
    const all = TEAM_MESSAGING_TOOLS;
    expect(
      selectTools(all, { message: "¿qué dijeron hoy en Slack sobre Centro Larrea?" }).groups,
    ).toContain("teamMessaging");
    expect(selectTools(all, { message: "Mostrame #firbot-dev" }).groups).toContain("teamMessaging");
    expect(toolsInNotes(["teamMessaging.search ✓ 3 team messages"])).toEqual([
      "teamMessaging.search",
    ]);
  });
});

describe("Morning Brief", () => {
  const channels = [
    { id: makeExternalRef(FIRBOT, "c", "C2"), name: "#sales" },
    { id: makeExternalRef(FIRBOT, "c", "C1"), name: "#firbot-dev" },
  ];
  const config = (over: object = {}) =>
    morningBriefConfigSchema.parse({
      blocks: ["slack"],
      slack: { connectionId: FIRBOT, channels, window: "since_previous" },
      ...over,
    });

  it("reads only the chosen channels of the chosen workspace, since the previous run", async () => {
    const { ports, firbot, larrea } = setup();
    const since = new Date("2026-09-28T11:00:00Z");
    const g = await gatherBrief(ports, makeCtx({ origin: "schedule" }), config(), since);
    expect(firbot.reads.map((r) => r.channel)).toEqual(channels.map((c) => c.id));
    expect(firbot.reads[0]!.after).toEqual(since);
    expect(larrea.reads).toHaveLength(0);
    expect(firbot.searches).toHaveLength(0);
    const brief = assembleBrief(g.data);
    expect(briefTopics(brief)).toContain("slack");
    expect(brief.slack!.channels[0]!.messages[0]).toMatchObject({
      author: "Juan",
      text: "recent news",
    });
  });

  it("no Slack block: nothing is read and there's no Slack section or warning", async () => {
    const { ports, firbot } = setup();
    const g = await gatherBrief(
      ports,
      makeCtx({ origin: "schedule" }),
      morningBriefConfigSchema.parse({ blocks: ["habits"] }),
    );
    expect(firbot.reads).toHaveLength(0);
    const brief = assembleBrief(g.data);
    expect(briefTopics(brief)).not.toContain("slack");
    expect(brief.warnings.find((w) => w.block === "slack")).toBeUndefined();
  });

  it("a worker without Slack settings says server setup, never 'not connected'", async () => {
    const { ports } = setup();
    ports.providers = {
      get: () => {
        throw new AppError("SERVER_NOT_CONFIGURED", "Slack is not configured on this server");
      },
    } as never;
    const g = await gatherBrief(ports, makeCtx({ origin: "schedule" }), config());
    const brief = assembleBrief(g.data);
    expect(brief.warnings).toEqual([
      { block: "slack", code: "SERVER_NOT_CONFIGURED", state: "server_config" },
    ]);
  });

  it("the Slack block needs a workspace and a channel; 'since the previous run' comes from the definition", () => {
    expect(morningBriefConfigSchema.safeParse({ blocks: ["slack"] }).success).toBe(false);
    const prev = previousOccurrence(
      { kind: "weekly", days: [1, 2, 3, 4, 5], time: "08:00" },
      tz,
      new Date("2026-10-19T11:00:00Z"),
    );
    // Monday 08:00 → the previous run was Friday 08:00 local.
    expect(prev).toEqual(new Date("2026-10-16T11:00:00Z"));
  });
});

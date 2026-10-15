import { describe, expect, it } from "vitest";

import { AppError } from "@/core/errors";
import { makeExternalRef } from "@/core/providers/refs";
import { scopesFor } from "@/infrastructure/providers/slack/oauth";
import {
  emojiName,
  plainText,
  SlackProvider,
  threadTsFromPermalink,
} from "@/infrastructure/providers/slack/team-messaging";

const CONN = "66666666-6666-4666-8666-666666666666";
const OTHER = "77777777-7777-4777-8777-777777777777";
const ref = (...p: string[]) => makeExternalRef(CONN, ...p);

type Args = Record<string, unknown>;
type Handler = (args: Args) => unknown;

/** A scripted Slack Web API: answers per method and records every call. */
class FakeSlack {
  calls: { method: string; args: Args }[] = [];
  constructor(private readonly handlers: Record<string, Handler> = {}) {}
  async call<T>(method: string, args: Args): Promise<T> {
    this.calls.push({ method, args });
    const h = this.handlers[method] ?? DEFAULTS[method];
    if (!h) throw new Error(`unexpected ${method}`);
    return h(args) as T;
  }
  of(method: string) {
    return this.calls.filter((c) => c.method === method);
  }
}

const PEOPLE = [
  { id: "U1", name: "juan", profile: { display_name: "Juan", real_name: "Juan Pérez" } },
  { id: "U2", name: "martin.p", profile: { real_name: "Martín Pérez" } },
  { id: "U3", name: "martin.g", profile: { real_name: "Martín Gómez" } },
  { id: "U4", name: "rod", profile: { display_name: "rod", real_name: "Rod Díaz" } },
];
const DEFAULTS: Record<string, Handler> = {
  "auth.test": () => ({ team: "Firbot", url: "https://firbot.slack.com/", user_id: "UME" }),
  "users.list": () => ({ members: PEOPLE }),
  "users.info": (a) => ({ user: PEOPLE.find((p) => p.id === a.user) ?? { id: a.user } }),
  "users.conversations": () => ({
    channels: [
      { id: "C1", name: "firbot-dev" },
      { id: "C2", name: "sales" },
      { id: "D4", is_im: true, user: "U4" },
    ],
  }),
};

function provider(fake: FakeSlack, scopes: string[], unlisted = false) {
  return new SlackProvider(
    { connectionId: CONN, label: "Firbot", unlisted },
    fake,
    async () => scopes,
  );
}

const rts =
  (messages: unknown[], files: unknown[] = []) =>
  () => ({ results: { messages, files } });
const hit = {
  author_name: "Juan",
  author_user_id: "U1",
  channel_id: "C1",
  channel_name: "firbot-dev",
  message_ts: "1760500000.000100",
  content: "El bug de <@U4> en WhatsApp ya quedó",
  permalink:
    "https://firbot.slack.com/archives/C1/p1760500000000100?thread_ts=1760400000.000200&cid=C1",
};

describe("Real-time Search", () => {
  it("searches only public channels when private and DMs weren't allowed, and says so", async () => {
    const fake = new FakeSlack({ "assistant.search.context": rts([hit]) });
    const r = await provider(fake, scopesFor([])).search({
      text: "WhatsApp",
      includeFiles: false,
      sort: "relevance",
      limit: 10,
    });
    const args = fake.of("assistant.search.context")[0]!.args;
    expect(args.channel_types).toEqual(["public_channel"]);
    expect(args.content_types).toEqual(["messages"]);
    expect(args.sort).toBe("score");
    expect(r.notSearched).toEqual(["private", "direct"]);
  });

  it("widens to private channels and DMs only with their scopes", async () => {
    const fake = new FakeSlack({ "assistant.search.context": rts([]) });
    const r = await provider(fake, scopesFor(["private", "direct", "files"])).search({
      text: "q",
      includeFiles: true,
      sort: "recent",
      limit: 5,
    });
    const args = fake.of("assistant.search.context")[0]!.args;
    expect(args.channel_types).toEqual(["public_channel", "private_channel", "im", "mpim"]);
    expect(args.content_types).toEqual(["messages", "files"]);
    // "lo último": keyword retrieval by time.
    expect(args.sort).toBe("timestamp");
    expect(r.notSearched).toEqual([]);
  });

  it("keeps provenance: workspace, channel, author, date, thread and the permalink", async () => {
    const fake = new FakeSlack({ "assistant.search.context": rts([hit]) });
    const [m] = (
      await provider(fake, scopesFor([])).search({
        text: "bug",
        includeFiles: false,
        sort: "relevance",
        limit: 5,
      })
    ).messages;
    expect(m).toMatchObject({
      id: ref("m", "C1", "1760500000.000100", "1760400000.000200"),
      threadId: ref("t", "C1", "1760400000.000200"),
      channel: { name: "firbot-dev" },
      author: { name: "Juan" },
      date: new Date(1760500000.0001 * 1000).toISOString(),
      url: hit.permalink,
      provenance: { providerKey: "slack", source: "Firbot", workspace: "Firbot" },
    });
    expect(m!.text).toContain("@rod");
  });

  it("turns time, person and channel into exact filters", async () => {
    const fake = new FakeSlack({ "assistant.search.context": rts([]) });
    await provider(fake, scopesFor([])).search({
      text: "propuesta",
      from: "Juan",
      channel: "#Firbot-Dev",
      after: new Date("2026-10-13T03:00:00Z"),
      before: new Date("2026-10-15T03:00:00Z"),
      includeFiles: false,
      sort: "relevance",
      limit: 10,
    });
    const args = fake.of("assistant.search.context")[0]!.args;
    expect(args.query).toBe("propuesta from:<@U1> in:<#C1>");
    expect(args.after).toBe(Date.parse("2026-10-13T03:00:00Z") / 1000);
    expect(args.before).toBe(Date.parse("2026-10-15T03:00:00Z") / 1000);
  });

  it("an ambiguous person is a question, never a guess", async () => {
    const fake = new FakeSlack({ "assistant.search.context": rts([]) });
    await expect(
      provider(fake, scopesFor([])).search({
        text: "x",
        from: "Martín",
        includeFiles: false,
        sort: "relevance",
        limit: 5,
      }),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      details: { reason: "ambiguous_destination" },
    });
    expect(fake.of("assistant.search.context")).toHaveLength(0);
  });

  it("falls back to legacy search only when Slack refuses RTS and the legacy scope exists", async () => {
    const refused = () => {
      throw new AppError("CAPABILITY_UNAVAILABLE", "x", {
        details: { reason: "search_unavailable" },
      });
    };
    const legacy = () => ({
      messages: {
        matches: [
          {
            ts: "1760500000.1",
            text: "public",
            user: "U1",
            channel: { id: "C1", name: "firbot-dev" },
            permalink: "https://firbot.slack.com/archives/C1/p1",
          },
          {
            ts: "1760500000.2",
            text: "secret",
            user: "U1",
            channel: { id: "G9", name: "board", is_private: true },
          },
          { ts: "1760500000.3", text: "dm", user: "U4", channel: { id: "D4", is_im: true } },
        ],
      },
    });
    const fake = new FakeSlack({ "assistant.search.context": refused, "search.messages": legacy });
    const r = await provider(fake, scopesFor([], true)).search({
      text: "x",
      includeFiles: false,
      sort: "relevance",
      limit: 10,
    });
    // Held to what the user allowed: no private channel, no DM.
    expect(r.messages.map((m) => m.text)).toEqual(["public"]);
    expect(r.notSearched).toEqual(["private", "direct"]);

    const noLegacy = new FakeSlack({ "assistant.search.context": refused });
    await expect(
      provider(noLegacy, scopesFor([])).search({
        text: "x",
        includeFiles: false,
        sort: "relevance",
        limit: 5,
      }),
    ).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
  });

  it("an unlisted app goes straight to legacy search with exact date bounds", async () => {
    const fake = new FakeSlack({
      "search.messages": () => ({
        messages: {
          matches: [
            {
              ts: String(Date.parse("2026-10-14T12:00:00Z") / 1000),
              text: "in",
              user: "U1",
              channel: { id: "C1" },
            },
            {
              ts: String(Date.parse("2026-10-12T12:00:00Z") / 1000),
              text: "out",
              user: "U1",
              channel: { id: "C1" },
            },
          ],
        },
      }),
    });
    const r = await provider(fake, scopesFor([], true), true).search({
      text: "x",
      after: new Date("2026-10-14T03:00:00Z"),
      includeFiles: false,
      sort: "recent",
      limit: 10,
    });
    expect(fake.of("assistant.search.context")).toHaveLength(0);
    expect(String(fake.of("search.messages")[0]!.args.query)).toContain("after:2026-10-13");
    expect(r.messages.map((m) => m.text)).toEqual(["in"]);
  });
});

describe("Bounded reads", () => {
  it("reads one thread from any message in it, one page only", async () => {
    const fake = new FakeSlack({
      "conversations.replies": () => ({
        messages: [
          { ts: "100.1", user: "U1", text: "root", thread_ts: "100.1", reply_count: 2 },
          { ts: "100.2", user: "U4", text: "reply", thread_ts: "100.1" },
          { ts: "100.3", subtype: "channel_join", text: "joined" },
        ],
        has_more: true,
      }),
    });
    const t = await provider(fake, scopesFor([]), true).getThread(ref("m", "C1", "100.2", "100.1"));
    expect(fake.of("conversations.replies")[0]!.args).toMatchObject({
      channel: "C1",
      ts: "100.1",
      limit: 15,
    });
    expect(t!.messages.map((m) => m.text)).toEqual(["root", "reply"]);
    expect(t).toMatchObject({
      id: ref("t", "C1", "100.1"),
      hasMore: true,
      url: "https://firbot.slack.com/archives/C1/p1001",
    });
  });

  it("reads a channel's window once, never paginating through history", async () => {
    const fake = new FakeSlack({
      "conversations.history": () => ({
        messages: [{ ts: "200.1", user: "U1", text: "hola" }],
        has_more: true,
      }),
    });
    const r = await provider(fake, scopesFor([])).getRecent(ref("c", "C2"), {
      after: new Date("2026-10-15T03:00:00Z"),
      limit: 20,
    });
    expect(fake.of("conversations.history")).toHaveLength(1);
    expect(fake.of("conversations.history")[0]!.args).toMatchObject({
      channel: "C2",
      oldest: String(Date.parse("2026-10-15T03:00:00Z") / 1000),
      limit: 20,
    });
    expect(r.hasMore).toBe(true);
    expect(r.messages[0]).toMatchObject({ channel: { name: "sales", kind: "public" } });
  });

  it("a ref from another workspace never reaches this one", async () => {
    const fake = new FakeSlack();
    await expect(
      provider(fake, scopesFor([])).getThread(makeExternalRef(OTHER, "t", "C1", "1.1")),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(fake.calls).toHaveLength(0);
  });
});

describe("Writes", () => {
  it("a direct message opens the conversation with that person and posts exactly the text", async () => {
    const fake = new FakeSlack({
      "conversations.open": () => ({ channel: { id: "D4" } }),
      "chat.postMessage": (a) => ({ channel: a.channel, ts: "300.1" }),
      "chat.getPermalink": () => ({ permalink: "https://firbot.slack.com/archives/D4/p3001" }),
    });
    const m = await provider(fake, scopesFor(["send"])).post({
      to: ref("u", "U4"),
      text: "En 10 minutos entro.",
      threadId: null,
    });
    expect(fake.of("conversations.open")[0]!.args).toEqual({ users: "U4" });
    expect(fake.of("chat.postMessage")[0]!.args).toEqual({
      channel: "D4",
      text: "En 10 minutos entro.",
    });
    expect(m).toMatchObject({
      id: ref("m", "D4", "300.1"),
      url: "https://firbot.slack.com/archives/D4/p3001",
    });
  });

  it("a reply goes to the thread's parent, never a reply's own ts", async () => {
    const fake = new FakeSlack({
      "chat.postMessage": (a) => ({ channel: a.channel, ts: "400.9" }),
      "chat.getPermalink": () => ({ permalink: "https://x.slack.com/p" }),
    });
    await provider(fake, scopesFor(["send"])).post({
      to: ref("c", "C1"),
      text: "Ya quedó resuelto",
      threadId: ref("m", "C1", "100.2", "100.1"),
    });
    expect(fake.of("chat.postMessage")[0]!.args).toMatchObject({
      channel: "C1",
      thread_ts: "100.1",
    });
  });

  it("reactions use Slack's names and treat 'already there' as done", async () => {
    const fake = new FakeSlack({
      "reactions.add": () => {
        throw new AppError("VALIDATION_ERROR", "x", {
          details: { providerReason: "already_reacted" },
        });
      },
    });
    await provider(fake, scopesFor(["reactions"])).react(ref("m", "C1", "1.1"), "👍", true);
    expect(fake.of("reactions.add")[0]!.args).toEqual({
      channel: "C1",
      timestamp: "1.1",
      name: "+1",
    });
    expect(emojiName(":white_check_mark:")).toBe("white_check_mark");
    expect(() => emojiName("<script>")).toThrow();
  });
});

describe("Slack text", () => {
  it("decodes mentions, channels and links into readable text", () => {
    expect(
      plainText("Hola <@U1> mirá <#C2|sales> y <https://x.com|esto> &amp; <!here>", () => "Juan"),
    ).toBe("Hola @Juan mirá #sales y esto (https://x.com) & @here");
    expect(threadTsFromPermalink(hit.permalink)).toBe("1760400000.000200");
    expect(threadTsFromPermalink("https://x.slack.com/archives/C1/p1")).toBeNull();
  });
});

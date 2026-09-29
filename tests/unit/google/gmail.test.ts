import { describe, expect, it, vi } from "vitest";

import { planCapabilityGrants } from "@/application/connections-service";
import { makeExternalRef } from "@/core/providers/refs";
import {
  buildGmailQuery,
  buildRawMessage,
  GmailProvider,
  normalizeMessage,
  normalizeThread,
  parseAddresses,
  type GMessage,
} from "@/infrastructure/providers/google/gmail";
import { GoogleHttp } from "@/infrastructure/providers/google/http";
import {
  CAPABILITY_SCOPES,
  grantedCapabilities,
  scopesFor,
} from "@/infrastructure/providers/google/oauth";

const CONN = {
  connectionId: "11111111-1111-4111-8111-111111111111",
  label: "Firbot",
  account: "leo@firbot.com",
};
const API = "https://gmail.googleapis.com/gmail/v1/users/me";
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");

type Call = { method: string; url: string; body: unknown };

function fakeGmail(routes: Record<string, (call: Call) => unknown>) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const call = {
      method: init?.method ?? "GET",
      url,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const key = Object.keys(routes)
      .sort((a, b) => b.length - a.length)
      .find((k) => {
        const [m, prefix] = k.split(" ");
        return m === call.method && url.startsWith(prefix!);
      });
    if (!key) return new Response(JSON.stringify({ error: { code: 404 } }), { status: 404 });
    const result = routes[key]!(call);
    if (result instanceof Response) return result;
    return new Response(result === undefined ? null : JSON.stringify(result), {
      status: result === undefined ? 204 : 200,
    });
  });
  const gmail = new GmailProvider(
    CONN,
    new GoogleHttp({ accessToken: async () => "t" }, fetchImpl),
  );
  return { gmail, calls };
}

const received: GMessage = {
  id: "m1",
  threadId: "t1",
  labelIds: ["INBOX", "UNREAD", "IMPORTANT", "CATEGORY_PERSONAL", "Label_7"],
  snippet: "Can we meet &amp; review?",
  internalDate: String(Date.parse("2026-09-28T12:00:00Z")),
  payload: {
    mimeType: "multipart/mixed",
    headers: [
      { name: "From", value: '"Rod, Jr." <rod@client.com>' },
      { name: "To", value: "leo@firbot.com, Ana <ana@client.com>" },
      { name: "Subject", value: "Proposal" },
      { name: "Message-ID", value: "<abc@client.com>" },
    ],
    parts: [
      {
        mimeType: "text/html",
        body: {
          data: b64(
            "<p>Hi Leo,<br>Friday works?</p><p>On Mon, Rod wrote:</p><blockquote>&gt; old</blockquote>",
          ),
        },
      },
      {
        mimeType: "application/pdf",
        filename: "quote.pdf",
        body: { attachmentId: "a1", size: 2048 },
      },
    ],
  },
};

describe("Gmail normalization", () => {
  it("maps a message into the canonical model with provenance, labels and attachments", () => {
    const m = normalizeMessage(received, CONN, { withBody: true });
    expect(m).toMatchObject({
      id: makeExternalRef(CONN.connectionId, "m", "m1"),
      threadId: makeExternalRef(CONN.connectionId, "t", "t1"),
      from: { email: "rod@client.com", name: "Rod, Jr." },
      to: [
        { email: "leo@firbot.com", name: null },
        { email: "ana@client.com", name: "Ana" },
      ],
      subject: "Proposal",
      snippet: "Can we meet & review?",
      date: "2026-09-28T12:00:00.000Z",
      unread: true,
      inInbox: true,
      important: true,
      fromMe: false,
      category: "primary",
      labels: ["inbox", "unread", "important"],
      attachments: [{ filename: "quote.pdf", mimeType: "application/pdf", size: 2048 }],
      bulk: false,
      rfcMessageId: "<abc@client.com>",
      provenance: { source: "Firbot", account: "leo@firbot.com", externalId: "m1" },
    });
    // HTML → text, quoted history removed.
    expect(m.body).toBe("Hi Leo,\nFriday works?");
    // Metadata listings never carry bodies.
    expect(normalizeMessage(received, CONN).body).toBeNull();
  });

  it("detects mailing lists and own messages", () => {
    const m = normalizeMessage(
      {
        id: "m2",
        threadId: "t1",
        labelIds: ["SENT", "CATEGORY_PROMOTIONS"],
        payload: { headers: [{ name: "List-Unsubscribe", value: "<mailto:x>" }] },
      },
      CONN,
    );
    expect(m).toMatchObject({ bulk: true, fromMe: true, category: "promotions" });
  });

  it("orders threads oldest first and leaves drafts out", () => {
    const t = normalizeThread(
      {
        id: "t1",
        messages: [
          { ...received, id: "late", internalDate: "2000" },
          { ...received, id: "early", internalDate: "1000" },
          { ...received, id: "draft", labelIds: ["DRAFT"] },
        ],
      },
      CONN,
    );
    expect(t.messages.map((m) => m.provenance.externalId)).toEqual(["early", "late"]);
  });

  it("parses address lists with quoted commas", () => {
    expect(parseAddresses('"Doe, Jane" <jane@x.com>, bob@y.com, bad')).toEqual([
      { email: "jane@x.com", name: "Doe, Jane" },
      { email: "bob@y.com", name: null },
    ]);
  });
});

describe("Gmail queries and MIME", () => {
  it("translates structured filters into Gmail search syntax", () => {
    expect(
      buildGmailQuery({
        from: "Rod (RSFA)",
        text: "AffordX",
        after: new Date("2026-09-28T03:00:00Z"),
        unread: true,
        inInbox: true,
        category: "primary",
        limit: 10,
      }),
    ).toBe(
      "AffordX from:(Rod  RSFA) after:1790564400 is:unread in:inbox category:primary -in:drafts",
    );
  });

  it("builds an RFC 5322 reply with UTF-8 subject and threading headers", () => {
    const raw = buildRawMessage(
      {
        to: [{ email: "rod@client.com", name: "Rod" }],
        cc: [],
        bcc: [],
        subject: "Re: Propuesta ñ",
        body: "Lo tenemos el viernes.\nSaludos",
        reply: { threadId: "x", inReplyTo: "<abc@client.com>", references: "<abc@client.com>" },
      },
      "leo@firbot.com",
    );
    const text = Buffer.from(raw, "base64url").toString("utf8");
    expect(text).toContain('To: "Rod" <rod@client.com>\r\n');
    expect(text).toContain("Subject: =?UTF-8?B?");
    expect(text).toContain("In-Reply-To: <abc@client.com>\r\n");
    const body = text.split("\r\n\r\n")[1]!.replace(/\r\n/g, "");
    expect(Buffer.from(body, "base64").toString("utf8")).toBe("Lo tenemos el viernes.\r\nSaludos");
  });

  it("rejects header injection", () => {
    expect(() =>
      buildRawMessage(
        {
          to: [{ email: "a@b.com", name: null }],
          cc: [],
          bcc: [],
          subject: "x\r\nBcc: evil@x.com",
          body: "b",
        },
        null,
      ),
    ).toThrow(/single line/);
  });
});

describe("GmailProvider", () => {
  const draftResponse = {
    id: "d1",
    message: {
      id: "dm1",
      threadId: "t1",
      payload: {
        mimeType: "text/plain",
        headers: [
          { name: "To", value: "rod@client.com" },
          { name: "Subject", value: "Re: Proposal" },
          { name: "In-Reply-To", value: "<abc@client.com>" },
        ],
        body: { data: b64("Ready Friday.\r\n") },
      },
    },
  };

  it("searches with metadata only (no bodies downloaded)", async () => {
    const { gmail, calls } = fakeGmail({
      [`GET ${API}/messages?`]: () => ({ messages: [{ id: "m1" }] }),
      [`GET ${API}/messages/m1`]: () => received,
    });
    const found = await gmail.search({ from: "rod", limit: 5 });
    expect(found).toHaveLength(1);
    expect(calls[1]!.url).toContain("format=metadata");
    expect(found[0]!.body).toBeNull();
  });

  it("creates a reply draft in the thread and reads it back", async () => {
    const { gmail, calls } = fakeGmail({
      [`POST ${API}/drafts`]: () => ({ id: "d1" }),
      [`GET ${API}/drafts/d1`]: () => draftResponse,
    });
    const draft = await gmail.createDraft({
      to: [{ email: "rod@client.com", name: null }],
      cc: [],
      bcc: [],
      subject: "Re: Proposal",
      body: "Ready Friday.",
      reply: {
        threadId: makeExternalRef(CONN.connectionId, "t", "t1"),
        inReplyTo: "<abc@client.com>",
        references: null,
      },
    });
    expect(calls[0]!.body).toMatchObject({ message: { threadId: "t1" } });
    expect(draft).toMatchObject({
      id: makeExternalRef(CONN.connectionId, "d", "d1"),
      threadId: makeExternalRef(CONN.connectionId, "t", "t1"),
      from: "leo@firbot.com",
      body: "Ready Friday.",
      inReplyTo: "<abc@client.com>",
    });
  });

  it("sends a draft once and treats a server error as an unknown outcome", async () => {
    let sends = 0;
    const ok = fakeGmail({
      [`POST ${API}/drafts/send`]: () => {
        sends++;
        return { id: "sent1", threadId: "t1", labelIds: ["SENT"] };
      },
    });
    const sent = await ok.gmail.sendDraft(makeExternalRef(CONN.connectionId, "d", "d1"));
    expect(sent.id).toBe(makeExternalRef(CONN.connectionId, "m", "sent1"));
    expect(sends).toBe(1);

    const broken = fakeGmail({
      [`POST ${API}/drafts/send`]: () => {
        sends++;
        return new Response("{}", { status: 503 });
      },
    });
    await expect(
      broken.gmail.sendDraft(makeExternalRef(CONN.connectionId, "d", "d1")),
    ).rejects.toMatchObject({ code: "UNKNOWN_OUTCOME" });
    expect(sends).toBe(2);
  });

  it("archives messages in one batch and threads per thread", async () => {
    const { gmail, calls } = fakeGmail({
      [`POST ${API}/messages/batchModify`]: () => undefined,
      [`POST ${API}/threads/`]: () => ({}),
    });
    await gmail.modify(
      [
        makeExternalRef(CONN.connectionId, "m", "m1"),
        makeExternalRef(CONN.connectionId, "t", "t9"),
      ],
      { archive: true },
    );
    expect(calls.map((c) => [c.method, c.url.replace(API, ""), c.body])).toEqual([
      [
        "POST",
        "/messages/batchModify",
        { ids: ["m1"], addLabelIds: [], removeLabelIds: ["INBOX"] },
      ],
      ["POST", "/threads/t9/modify", { addLabelIds: [], removeLabelIds: ["INBOX"] }],
    ]);
  });

  it("refuses ids from another connection", async () => {
    const { gmail } = fakeGmail({});
    await expect(
      gmail.getThread(makeExternalRef("22222222-2222-4222-8222-222222222222", "t", "t1")),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("maps a revoked Gmail grant to a reconnect error", async () => {
    const { gmail } = fakeGmail({
      [`GET ${API}/messages?`]: () =>
        new Response(
          JSON.stringify({ error: { errors: [{ reason: "insufficientPermissions" }] } }),
          {
            status: 403,
          },
        ),
    });
    await expect(gmail.search({ limit: 5 })).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
      recovery: "reconnect",
    });
  });
});

describe("incremental Gmail authorization", () => {
  const all = [...CAPABILITY_SCOPES.calendar, ...CAPABILITY_SCOPES.tasks];

  it("requests only identity + Gmail when enabling Gmail on an existing account", () => {
    expect(scopesFor(["email"])).toEqual([
      "openid",
      "email",
      "profile",
      "https://www.googleapis.com/auth/gmail.modify",
    ]);
  });

  it("keeps Calendar and Tasks enabled when Gmail is added", () => {
    const granted = grantedCapabilities([...all, ...CAPABILITY_SCOPES.email, "openid"]);
    expect(granted.sort()).toEqual(["calendar", "email", "tasks"]);
    const plan = planCapabilityGrants({
      requested: ["email"],
      granted,
      wasEnabled: new Set(["calendar", "tasks"]),
    });
    expect(plan).toEqual([
      { capability: "calendar", enabled: true, scopes: [...CAPABILITY_SCOPES.calendar] },
      { capability: "tasks", enabled: true, scopes: [...CAPABILITY_SCOPES.tasks] },
      { capability: "email", enabled: true, scopes: [...CAPABILITY_SCOPES.email] },
    ]);
  });

  it("records Gmail as not granted when the user declines it, without touching the rest", () => {
    const plan = planCapabilityGrants({
      requested: ["email"],
      granted: grantedCapabilities(all),
      wasEnabled: new Set(["calendar"]),
    });
    expect(plan).toEqual([
      { capability: "calendar", enabled: true, scopes: [...CAPABILITY_SCOPES.calendar] },
      { capability: "email", enabled: false, scopes: [] },
    ]);
  });
});

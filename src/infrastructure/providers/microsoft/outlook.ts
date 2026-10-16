import type {
  EmailAddress,
  EmailDraft,
  EmailMessage,
  EmailProvider,
  EmailQuery,
  EmailThread,
  NewDraft,
} from "@/core/capabilities/email";
import { AppError } from "@/core/errors";
import { makeExternalRef, parseExternalRef } from "@/core/providers/refs";

import type { GraphHttp } from "./http";
import { GRAPH_URL } from "./oauth";
import { htmlToText, stripQuoted } from "../google/gmail";

/**
 * Outlook Mail (Microsoft Graph) behind the canonical Email capability (ADR-058). Ids in and out
 * are ELISE refs scoped to this connection: "m" = message id, "t" = conversationId,
 * "d" = draft message id. Immutable ids keep a message's id stable when it is archived/moved.
 * Nothing is copied into ELISE; every read goes to Outlook.
 */
const ME = `${GRAPH_URL}/me`;
/** Plain-text bodies from Graph (it converts HTML server-side) and move-proof ids. */
const PREFER = { prefer: 'outlook.body-content-type="text", IdType="ImmutableId"' };
const FIELDS = [
  "id",
  "conversationId",
  "conversationIndex",
  "subject",
  "bodyPreview",
  "from",
  "toRecipients",
  "ccRecipients",
  "bccRecipients",
  "replyTo",
  "receivedDateTime",
  "sentDateTime",
  "isRead",
  "isDraft",
  "importance",
  "flag",
  "hasAttachments",
  "parentFolderId",
  "internetMessageId",
  "inferenceClassification",
  "webLink",
  "internetMessageHeaders",
].join(",");
/** Full reads add the body without quoted history and attachment metadata (never content). */
const FULL = `$select=${FIELDS},body,uniqueBody&$expand=attachments($select=name,contentType,size,isInline)`;
const THREAD_MAX = 50;

export interface OutlookConnectionInfo {
  connectionId: string;
  /** User-facing account name ("Personal", "Empresa"). */
  label: string;
  /** The connected Microsoft address. */
  account: string | null;
}

// ── Graph shapes (only the fields we use) ────────────────────────────────────

interface GRecipient {
  emailAddress?: { name?: string | null; address?: string | null };
}

export interface GMessage {
  id: string;
  conversationId?: string;
  conversationIndex?: string;
  subject?: string | null;
  bodyPreview?: string;
  body?: { contentType?: string; content?: string };
  uniqueBody?: { contentType?: string; content?: string };
  from?: GRecipient | null;
  toRecipients?: GRecipient[];
  ccRecipients?: GRecipient[];
  bccRecipients?: GRecipient[];
  replyTo?: GRecipient[];
  receivedDateTime?: string | null;
  sentDateTime?: string | null;
  isRead?: boolean;
  isDraft?: boolean;
  importance?: string;
  flag?: { flagStatus?: string };
  hasAttachments?: boolean;
  parentFolderId?: string;
  internetMessageId?: string | null;
  inferenceClassification?: string;
  webLink?: string;
  internetMessageHeaders?: { name: string; value: string }[];
  attachments?: { name?: string; contentType?: string; size?: number; isInline?: boolean }[];
}

/** Well-known folder ids of this mailbox (to tell inbox/sent apart and skip trash/junk). */
export interface Folders {
  inbox: string | null;
  sentitems: string | null;
  deleteditems: string | null;
  junkemail: string | null;
}

// ── Normalization ────────────────────────────────────────────────────────────

function address(r: GRecipient | null | undefined): EmailAddress | null {
  const email = r?.emailAddress?.address?.trim();
  if (!email) return null;
  return { email, name: r?.emailAddress?.name?.trim() || null };
}

function addresses(list: GRecipient[] | undefined): EmailAddress[] {
  return (list ?? []).map(address).filter((a): a is EmailAddress => a !== null);
}

function header(m: GMessage, name: string): string | null {
  return m.internetMessageHeaders?.find((h) => h.name.toLowerCase() === name)?.value ?? null;
}

/** Text of a Graph body; HTML (if the text preference was ignored) is converted safely. */
function text(body: GMessage["body"]): string | null {
  if (!body?.content) return null;
  return body.contentType?.toLowerCase() === "html" ? htmlToText(body.content) : body.content;
}

/**
 * A reply's conversationIndex is the 22-byte header plus 5 bytes per reply, so a draft longer
 * than 22 bytes answers an existing conversation; a new email starts its own.
 */
export function isReplyIndex(conversationIndex: string | undefined): boolean {
  return Boolean(conversationIndex) && Buffer.from(conversationIndex!, "base64").length > 22;
}

const provenance = (conn: OutlookConnectionInfo, externalId: string) => ({
  providerKey: "microsoft" as const,
  connectionId: conn.connectionId,
  externalId,
  source: conn.label,
  account: conn.account,
});

export function normalizeMessage(
  m: GMessage,
  conn: OutlookConnectionInfo,
  folders: Folders,
  options: { withBody?: boolean } = {},
): EmailMessage {
  const from = address(m.from);
  const precedence = header(m, "precedence")?.toLowerCase() ?? "";
  const when = new Date(m.receivedDateTime ?? m.sentDateTime ?? 0);
  const inInbox = Boolean(folders.inbox && m.parentFolderId === folders.inbox);
  const sent = Boolean(folders.sentitems && m.parentFolderId === folders.sentitems);
  const important = m.importance?.toLowerCase() === "high";
  const flagged = m.flag?.flagStatus === "flagged";
  const body = options.withBody ? (text(m.uniqueBody) ?? text(m.body)) : null;
  return {
    id: makeExternalRef(conn.connectionId, "m", m.id),
    threadId: makeExternalRef(conn.connectionId, "t", m.conversationId ?? m.id),
    from,
    to: addresses(m.toRecipients),
    cc: addresses(m.ccRecipients),
    replyTo: addresses(m.replyTo),
    subject: m.subject?.trim() || "(no subject)",
    snippet: (m.bodyPreview ?? "").replace(/\s+/g, " ").trim(),
    date: (Number.isNaN(when.getTime()) ? new Date(0) : when).toISOString(),
    unread: m.isRead === false,
    inInbox,
    important,
    fromMe:
      sent ||
      Boolean(from && conn.account && from.email.toLowerCase() === conn.account.toLowerCase()),
    // Outlook's Focused inbox ≈ Gmail's Primary tab; "Other" has no exact tab, so no category.
    category: m.inferenceClassification === "focused" ? "primary" : null,
    labels: [
      ...(inInbox ? ["inbox"] : []),
      ...(m.isRead === false ? ["unread"] : []),
      ...(important ? ["important"] : []),
      ...(flagged ? ["starred"] : []),
      ...(sent ? ["sent"] : []),
      ...(m.isDraft ? ["draft"] : []),
    ],
    attachments: (m.attachments ?? [])
      .filter((a) => !a.isInline)
      .map((a) => ({
        filename: a.name ?? "attachment",
        mimeType: a.contentType ?? "application/octet-stream",
        size: a.size ?? 0,
      })),
    bulk:
      Boolean(header(m, "list-unsubscribe") || header(m, "list-id")) ||
      ["bulk", "list", "junk"].includes(precedence),
    body: body === null ? null : stripQuoted(body.replace(/\r\n/g, "\n")),
    rfcMessageId: m.internetMessageId ?? null,
    references: header(m, "references"),
    url: m.webLink ?? null,
    provenance: provenance(conn, m.id),
  };
}

export function normalizeThread(
  conversationId: string,
  messages: GMessage[],
  conn: OutlookConnectionInfo,
  folders: Folders,
  options: { withBody?: boolean } = {},
): EmailThread {
  const list = messages
    .filter((m) => !m.isDraft)
    .map((m) => normalizeMessage(m, conn, folders, options))
    .sort((a, b) => a.date.localeCompare(b.date));
  return {
    id: makeExternalRef(conn.connectionId, "t", conversationId),
    subject: list[0]?.subject ?? "(no subject)",
    messages: list,
    url: list.at(-1)?.url ?? null,
    provenance: provenance(conn, conversationId),
  };
}

export function normalizeDraft(m: GMessage, conn: OutlookConnectionInfo): EmailDraft {
  return {
    id: makeExternalRef(conn.connectionId, "d", m.id),
    threadId:
      m.conversationId && isReplyIndex(m.conversationIndex)
        ? makeExternalRef(conn.connectionId, "t", m.conversationId)
        : null,
    from: address(m.from)?.email ?? conn.account,
    to: addresses(m.toRecipients),
    cc: addresses(m.ccRecipients),
    bcc: addresses(m.bccRecipients),
    subject: m.subject ?? "",
    // Exactly what would be sent (no quote stripping).
    body: (text(m.body) ?? "").replace(/\r\n/g, "\n").trim(),
    // Outlook threads replies itself (the draft was created as a reply); no headers to carry.
    inReplyTo: null,
    references: null,
    url: m.webLink ?? null,
    provenance: provenance(conn, m.id),
  };
}

// ── Queries ──────────────────────────────────────────────────────────────────

/** OData string literal: single quotes doubled. */
const odata = (v: string) => `'${v.replace(/'/g, "''")}'`;
/** KQL value: no quotes, grouping or field separators from user text. */
const kql = (v: string) =>
  v
    .replace(/["\\():]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
const day = (d: Date) => d.toISOString().slice(0, 10);
const DAY_MS = 86_400_000;

/**
 * Structured filters → one Graph list request. Words (text/from/to/subject) use $search (KQL),
 * which Graph can't combine with $filter/$orderby, so the rest is checked afterwards by
 * `matchesQuery`; without words, an indexed $filter + $orderby does it all server-side.
 */
export function buildListRequest(q: EmailQuery): { path: string; params: URLSearchParams } {
  const folder = q.sent ? "mailFolders/sentitems/" : q.inInbox ? "mailFolders/inbox/" : "";
  const params = new URLSearchParams({ $select: FIELDS });
  const words = [
    q.text && kql(q.text),
    q.from && `from:${kql(q.from)}`,
    q.to && `to:${kql(q.to)}`,
    q.subject && `subject:${kql(q.subject)}`,
  ].filter((w): w is string => Boolean(w && !/:$/.test(w)));
  if (words.length) {
    // A day of margin each side (KQL dates are whole days); exact bounds are applied after.
    if (q.after) words.push(`received>=${day(new Date(q.after.getTime() - DAY_MS))}`);
    if (q.before) words.push(`received<=${day(new Date(q.before.getTime() + DAY_MS))}`);
    if (q.hasAttachment) words.push("hasattachments:true");
    params.set("$search", `"${words.join(" ")}"`);
    params.set("$top", String(Math.min(100, q.limit * 3)));
  } else {
    // receivedDateTime first: Graph needs the $orderby property to lead the $filter.
    const filter = [
      `receivedDateTime ge ${(q.after ?? new Date("2000-01-01T00:00:00Z")).toISOString()}`,
      ...(q.before ? [`receivedDateTime lt ${q.before.toISOString()}`] : []),
      ...(q.unread !== undefined ? [`isRead eq ${!q.unread}`] : []),
      ...(q.hasAttachment ? ["hasAttachments eq true"] : []),
      ...(q.category
        ? [`inferenceClassification eq ${odata(q.category === "primary" ? "focused" : "other")}`]
        : []),
      "isDraft eq false",
    ];
    params.set("$filter", filter.join(" and "));
    params.set("$orderby", "receivedDateTime desc");
    params.set("$top", String(Math.min(100, q.limit * (folder ? 1 : 2))));
  }
  return { path: `${folder}messages`, params };
}

/** The filters $search could not apply, plus never drafts, trash or junk (like Gmail). */
export function matchesQuery(m: GMessage, q: EmailQuery, folders: Folders): boolean {
  if (m.isDraft) return false;
  if (m.parentFolderId && [folders.deleteditems, folders.junkemail].includes(m.parentFolderId))
    return false;
  const at = new Date(m.receivedDateTime ?? m.sentDateTime ?? 0).getTime();
  if (q.after && at < q.after.getTime()) return false;
  if (q.before && at >= q.before.getTime()) return false;
  if (q.unread !== undefined && (m.isRead === false) !== q.unread) return false;
  if (q.hasAttachment && !m.hasAttachments) return false;
  if (q.category && (m.inferenceClassification === "focused") !== (q.category === "primary"))
    return false;
  return true;
}

const folderCache = new Map<string, Promise<Folders>>();

// ── Provider ─────────────────────────────────────────────────────────────────

export class OutlookProvider implements EmailProvider {
  constructor(
    private readonly conn: OutlookConnectionInfo,
    private readonly http: Pick<GraphHttp, "request">,
  ) {}

  private parse(ref: string, kind: "m" | "t" | "d"): string {
    const parsed = parseExternalRef(ref);
    if (!parsed || parsed.connectionId !== this.conn.connectionId || parsed.parts[0] !== kind) {
      throw new AppError("VALIDATION_ERROR", "That email item does not belong to this account", {
        recovery: "review",
      });
    }
    return parsed.parts[1] ?? "";
  }

  private get<T>(url: string, notFoundAsNull = false) {
    return this.http.request<T>("GET", url, undefined, { notFoundAsNull, headers: PREFER });
  }

  private write<T>(method: "POST" | "PATCH" | "DELETE", url: string, body?: unknown) {
    return this.http.request<T>(method, url, body, { headers: PREFER });
  }

  /** Folder ids in one $batch round trip, remembered per connection (they don't change). */
  private folders(): Promise<Folders> {
    let cached = folderCache.get(this.conn.connectionId);
    if (!cached) {
      const names = ["inbox", "sentitems", "deleteditems", "junkemail"] as const;
      cached = this.http
        .request<{ responses?: { id: string; status: number; body?: { id?: string } }[] }>(
          "POST",
          `${GRAPH_URL}/$batch`,
          {
            requests: names.map((n) => ({
              id: n,
              method: "GET",
              url: `/me/mailFolders/${n}?$select=id`,
              headers: PREFER,
            })),
          },
        )
        .then((res) => {
          const id = (n: string) =>
            res?.responses?.find((r) => r.id === n && r.status === 200)?.body?.id ?? null;
          return {
            inbox: id("inbox"),
            sentitems: id("sentitems"),
            deleteditems: id("deleteditems"),
            junkemail: id("junkemail"),
          };
        });
      // A failed lookup is retried next time instead of being remembered.
      cached.catch(() => folderCache.delete(this.conn.connectionId));
      folderCache.set(this.conn.connectionId, cached);
    }
    return cached;
  }

  private async list(q: EmailQuery): Promise<GMessage[]> {
    const { path, params } = buildListRequest(q);
    const [res, folders] = await Promise.all([
      this.get<{ value?: GMessage[] }>(`${ME}/${path}?${params}`),
      this.folders(),
    ]);
    return (res?.value ?? [])
      .filter((m) => matchesQuery(m, q, folders))
      .sort((a, b) => (b.receivedDateTime ?? "").localeCompare(a.receivedDateTime ?? ""));
  }

  private async conversation(conversationId: string, full: boolean): Promise<GMessage[]> {
    // Graph refuses $orderby with this filter; the thread is sorted after.
    const params = new URLSearchParams({
      $filter: `conversationId eq ${odata(conversationId)}`,
      $top: String(THREAD_MAX),
    });
    const select = full ? FULL : `$select=${FIELDS}`;
    const [res, folders] = await Promise.all([
      this.get<{ value?: GMessage[] }>(`${ME}/messages?${params}&${select}`),
      this.folders(),
    ]);
    return (res?.value ?? []).filter(
      (m) =>
        !m.parentFolderId || ![folders.deleteditems, folders.junkemail].includes(m.parentFolderId),
    );
  }

  async search(query: EmailQuery): Promise<EmailMessage[]> {
    const [messages, folders] = await Promise.all([this.list(query), this.folders()]);
    return messages.slice(0, query.limit).map((m) => normalizeMessage(m, this.conn, folders));
  }

  async searchThreads(query: EmailQuery): Promise<EmailThread[]> {
    const messages = await this.list({ ...query, limit: Math.min(50, query.limit * 2) });
    const ids = [...new Set(messages.map((m) => m.conversationId).filter(Boolean))].slice(
      0,
      query.limit,
    ) as string[];
    const [threads, folders] = await Promise.all([
      Promise.all(ids.map((id) => this.conversation(id, false))),
      this.folders(),
    ]);
    return ids
      .map((id, i) => normalizeThread(id, threads[i]!, this.conn, folders))
      .filter((t) => t.messages.length > 0);
  }

  async getMessage(messageId: string): Promise<EmailMessage | null> {
    const id = this.parse(messageId, "m");
    const [m, folders] = await Promise.all([
      this.get<GMessage>(`${ME}/messages/${encodeURIComponent(id)}?${FULL}`, true),
      this.folders(),
    ]);
    return m && !m.isDraft ? normalizeMessage(m, this.conn, folders, { withBody: true }) : null;
  }

  async peek(ids: string[]): Promise<EmailMessage[]> {
    const folders = await this.folders();
    const found = await Promise.all(
      ids.map(async (ref) => {
        if (parseExternalRef(ref)?.parts[0] !== "t")
          return this.get<GMessage>(
            `${ME}/messages/${encodeURIComponent(this.parse(ref, "m"))}?$select=${FIELDS}`,
            true,
          );
        const thread = await this.conversation(this.parse(ref, "t"), false);
        return (
          thread
            .filter((m) => !m.isDraft)
            .sort((a, b) => (a.receivedDateTime ?? "").localeCompare(b.receivedDateTime ?? ""))
            .at(-1) ?? null
        );
      }),
    );
    return found
      .filter((m): m is GMessage => m !== null)
      .map((m) => normalizeMessage(m, this.conn, folders));
  }

  async getThread(threadId: string): Promise<EmailThread | null> {
    const id = this.parse(threadId, "t");
    const [messages, folders] = await Promise.all([this.conversation(id, true), this.folders()]);
    const thread = normalizeThread(id, messages, this.conn, folders, { withBody: true });
    return thread.messages.length ? thread : null;
  }

  private async draftMessage(id: string): Promise<GMessage | null> {
    const m = await this.get<GMessage>(
      `${ME}/messages/${encodeURIComponent(id)}?$select=${FIELDS},body`,
      true,
    );
    return m?.isDraft ? m : null;
  }

  async getDraft(draftId: string): Promise<EmailDraft | null> {
    const m = await this.draftMessage(this.parse(draftId, "d"));
    return m ? normalizeDraft(m, this.conn) : null;
  }

  /** A "d" ref must name a draft: sending or deleting never touches a real message. */
  private async existingDraft(draftId: string): Promise<GMessage> {
    const m = await this.draftMessage(this.parse(draftId, "d"));
    if (!m) throw new AppError("NOT_FOUND", "That draft no longer exists", { recovery: "review" });
    return m;
  }

  private fields(draft: NewDraft) {
    const recipients = (list: EmailAddress[]) =>
      list.map((a) => ({
        emailAddress: { address: a.email, ...(a.name ? { name: a.name } : {}) },
      }));
    return {
      subject: draft.subject,
      body: { contentType: "Text", content: draft.body },
      toRecipients: recipients(draft.to),
      ccRecipients: recipients(draft.cc),
      bccRecipients: recipients(draft.bcc),
    };
  }

  /** The message a reply answers: by its Message-ID, else the conversation's latest. */
  private async replyTarget(reply: NonNullable<NewDraft["reply"]>): Promise<string> {
    if (reply.inReplyTo) {
      const params = new URLSearchParams({
        $filter: `internetMessageId eq ${odata(reply.inReplyTo)}`,
        $select: "id,isDraft",
        $top: "5",
      });
      const res = await this.get<{ value?: GMessage[] }>(`${ME}/messages?${params}`);
      const hit = res?.value?.find((m) => !m.isDraft);
      if (hit) return hit.id;
    }
    const latest = (await this.conversation(this.parse(reply.threadId, "t"), false))
      .filter((m) => !m.isDraft)
      .sort((a, b) => (a.receivedDateTime ?? "").localeCompare(b.receivedDateTime ?? ""))
      .at(-1);
    if (!latest)
      throw new AppError("NOT_FOUND", "The email being answered no longer exists", {
        recovery: "review",
      });
    return latest.id;
  }

  private async reread(created: GMessage | null): Promise<EmailDraft> {
    if (!created?.id)
      throw new AppError("PROVIDER_UNAVAILABLE", "Outlook did not return the draft");
    const draft = await this.getDraft(makeExternalRef(this.conn.connectionId, "d", created.id));
    if (!draft) throw new AppError("PROVIDER_UNAVAILABLE", "Outlook did not return the draft");
    return draft;
  }

  async createDraft(draft: NewDraft): Promise<EmailDraft> {
    if (!draft.reply)
      return this.reread(await this.write<GMessage>("POST", `${ME}/messages`, this.fields(draft)));
    // createReply keeps Outlook's own threading (In-Reply-To, conversation); ELISE then sets
    // exactly the recipients, subject and text it computed.
    const original = await this.replyTarget(draft.reply);
    const created = await this.write<GMessage>(
      "POST",
      `${ME}/messages/${encodeURIComponent(original)}/createReply`,
      {},
    );
    if (!created?.id)
      throw new AppError("PROVIDER_UNAVAILABLE", "Outlook did not return the draft");
    return this.reread(
      await this.write<GMessage>(
        "PATCH",
        `${ME}/messages/${encodeURIComponent(created.id)}`,
        this.fields(draft),
      ),
    );
  }

  async updateDraft(draftId: string, draft: NewDraft): Promise<EmailDraft> {
    const current = await this.existingDraft(draftId);
    return this.reread(
      await this.write<GMessage>(
        "PATCH",
        `${ME}/messages/${encodeURIComponent(current.id)}`,
        this.fields(draft),
      ),
    );
  }

  async sendDraft(draftId: string): Promise<EmailMessage> {
    const draft = await this.existingDraft(draftId);
    // 202 Accepted = Outlook took it; any failure surfaces as an error (or UNKNOWN_OUTCOME).
    await this.write("POST", `${ME}/messages/${encodeURIComponent(draft.id)}/send`);
    const folders = await this.folders();
    // Sending gives the message a new id in Sent Items: find it by Message-ID (best effort).
    const sent = draft.internetMessageId
      ? await this.get<{ value?: GMessage[] }>(
          `${ME}/mailFolders/sentitems/messages?${new URLSearchParams({
            $filter: `internetMessageId eq ${odata(draft.internetMessageId)}`,
            $select: FIELDS,
            $top: "1",
          })}`,
        )
          .then((r) => r?.value?.[0] ?? null)
          .catch(() => null)
      : null;
    return normalizeMessage(
      sent ?? {
        ...draft,
        isDraft: false,
        parentFolderId: folders.sentitems ?? undefined,
        sentDateTime: new Date().toISOString(),
        receivedDateTime: new Date().toISOString(),
      },
      this.conn,
      folders,
    );
  }

  async deleteDraft(draftId: string): Promise<void> {
    const draft = await this.existingDraft(draftId);
    await this.write("DELETE", `${ME}/messages/${encodeURIComponent(draft.id)}`);
  }

  async modify(ids: string[], change: { archive?: boolean; read?: boolean }): Promise<void> {
    const folders = await this.folders();
    // Message id → its folder (unknown for a single message until read).
    const targets = new Map<string, string | undefined>();
    for (const ref of ids) {
      if (parseExternalRef(ref)?.parts[0] !== "t") {
        targets.set(this.parse(ref, "m"), undefined);
        continue;
      }
      for (const m of await this.conversation(this.parse(ref, "t"), false))
        if (!m.isDraft) targets.set(m.id, m.parentFolderId ?? "");
    }
    await Promise.all(
      [...targets].map(async ([id, known]) => {
        const path = `${ME}/messages/${encodeURIComponent(id)}`;
        if (change.read !== undefined) await this.write("PATCH", path, { isRead: change.read });
        if (!change.archive) return;
        const folder =
          known ?? (await this.get<GMessage>(`${path}?$select=id,parentFolderId`))?.parentFolderId;
        // Only inbox mail is archived (like removing Gmail's INBOX label); immutable ids survive
        // the move, so the refs ELISE showed keep working.
        if (!folders.inbox || folder === folders.inbox)
          await this.write("POST", `${path}/move`, { destinationId: "archive" });
      }),
    );
  }
}

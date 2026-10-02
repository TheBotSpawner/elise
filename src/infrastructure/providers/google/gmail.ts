import type {
  EmailAddress,
  EmailAttachment,
  EmailCategory,
  EmailDraft,
  EmailMessage,
  EmailProvider,
  EmailQuery,
  EmailThread,
  NewDraft,
} from "@/core/capabilities/email";
import { AppError } from "@/core/errors";
import { makeExternalRef, parseExternalRef } from "@/core/providers/refs";

import type { GoogleHttp } from "./http";

const API = "https://gmail.googleapis.com/gmail/v1/users/me";
/** Parallel Gmail calls per request (per-user quota is shared by every request). */
const CONCURRENCY = 8;
const METADATA_HEADERS = [
  "From",
  "To",
  "Cc",
  "Reply-To",
  "Subject",
  "Date",
  "Message-ID",
  "References",
  "List-Unsubscribe",
  "List-Id",
  "Precedence",
];

export interface GmailConnectionInfo {
  connectionId: string;
  /** User-facing account name ("Personal", "Acme"). */
  label: string;
  /** The connected Google address. */
  account: string | null;
}

// ── Gmail API shapes (only the fields we use) ────────────────────────────────

export interface GPart {
  mimeType?: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: GPart[];
}

export interface GMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: GPart;
}

export interface GThread {
  id: string;
  messages?: GMessage[];
}

export interface GDraft {
  id: string;
  message?: GMessage;
}

// ── Parsing ──────────────────────────────────────────────────────────────────

function header(part: GPart | undefined, name: string): string | null {
  const h = part?.headers?.find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : null;
}

/** Splits an address header on commas outside quotes and angle brackets. */
export function parseAddresses(value: string | null): EmailAddress[] {
  if (!value) return [];
  const items: string[] = [];
  let current = "";
  let quoted = false;
  let angle = false;
  for (const ch of value) {
    if (ch === '"') quoted = !quoted;
    else if (ch === "<" && !quoted) angle = true;
    else if (ch === ">" && !quoted) angle = false;
    if (ch === "," && !quoted && !angle) {
      items.push(current);
      current = "";
    } else current += ch;
  }
  items.push(current);
  return items.flatMap((raw) => {
    const item = raw.trim();
    if (!item) return [];
    const match = /^(.*)<([^<>]+)>\s*$/.exec(item);
    const email = (match ? match[2]! : item).trim();
    if (!email.includes("@")) return [];
    const name = match ? match[1]!.trim().replace(/^"|"$/g, "").replace(/\\"/g, '"').trim() : "";
    return [{ email, name: name || null }];
  });
}

function decodeBase64Url(data: string): string {
  return Buffer.from(data, "base64url").toString("utf8");
}

const ENTITIES: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

export function htmlToText(html: string): string {
  return html
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === "#") {
        const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1));
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Removes the quoted history replies carry ("On … wrote:", "> …"), so a thread shows each
 * message once and the model's context stays small.
 */
export function stripQuoted(text: string): string {
  const lines = text.split("\n");
  const cut = lines.findIndex(
    (l) =>
      /^\s*(On|El)\s.+(wrote|escribió)\s*:\s*$/i.test(l) ||
      /^-{2,}\s*(Original Message|Mensaje original)\s*-{2,}/i.test(l),
  );
  const kept = (cut > 0 ? lines.slice(0, cut) : lines).filter((l) => !/^\s*>/.test(l));
  return kept.join("\n").trim();
}

function walk(part: GPart | undefined, visit: (p: GPart) => void) {
  if (!part) return;
  visit(part);
  for (const child of part.parts ?? []) walk(child, visit);
}

export function extractBody(payload: GPart | undefined): string | null {
  let plain: string | null = null;
  let html: string | null = null;
  walk(payload, (p) => {
    if (p.filename || !p.body?.data) return;
    if (p.mimeType === "text/plain" && plain === null) plain = decodeBase64Url(p.body.data);
    if (p.mimeType === "text/html" && html === null) html = decodeBase64Url(p.body.data);
  });
  const text = plain ?? (html !== null ? htmlToText(html) : null);
  return text === null ? null : stripQuoted(text);
}

/** Attachment metadata only; bodies are never downloaded here. */
export function extractAttachments(payload: GPart | undefined): EmailAttachment[] {
  const out: EmailAttachment[] = [];
  walk(payload, (p) => {
    if (p.filename && p.body?.attachmentId) {
      out.push({
        filename: p.filename,
        mimeType: p.mimeType ?? "application/octet-stream",
        size: p.body.size ?? 0,
      });
    }
  });
  return out;
}

const CATEGORIES: Record<string, EmailCategory> = {
  CATEGORY_PERSONAL: "primary",
  CATEGORY_PROMOTIONS: "promotions",
  CATEGORY_SOCIAL: "social",
  CATEGORY_UPDATES: "updates",
  CATEGORY_FORUMS: "forums",
};

const KEPT_LABELS = new Set(["INBOX", "UNREAD", "IMPORTANT", "STARRED", "SENT", "DRAFT"]);

function webUrl(conn: GmailConnectionInfo, fragment: string): string {
  const user = conn.account ? `?authuser=${encodeURIComponent(conn.account)}` : "";
  return `https://mail.google.com/mail/${user}#${fragment}`;
}

// ── Normalization ────────────────────────────────────────────────────────────

export function normalizeMessage(
  m: GMessage,
  conn: GmailConnectionInfo,
  options: { withBody?: boolean } = {},
): EmailMessage {
  const labels = m.labelIds ?? [];
  const p = m.payload;
  const from = parseAddresses(header(p, "From"))[0] ?? null;
  const precedence = header(p, "Precedence")?.toLowerCase() ?? "";
  const dateHeader = header(p, "Date");
  const date = m.internalDate
    ? new Date(Number(m.internalDate))
    : dateHeader
      ? new Date(dateHeader)
      : new Date(0);
  return {
    id: makeExternalRef(conn.connectionId, "m", m.id),
    threadId: makeExternalRef(conn.connectionId, "t", m.threadId),
    from,
    to: parseAddresses(header(p, "To")),
    cc: parseAddresses(header(p, "Cc")),
    replyTo: parseAddresses(header(p, "Reply-To")),
    subject: header(p, "Subject")?.trim() || "(no subject)",
    snippet: decodeSnippet(m.snippet ?? ""),
    date: (Number.isNaN(date.getTime()) ? new Date(0) : date).toISOString(),
    unread: labels.includes("UNREAD"),
    inInbox: labels.includes("INBOX"),
    important: labels.includes("IMPORTANT"),
    fromMe:
      labels.includes("SENT") ||
      Boolean(from && conn.account && from.email.toLowerCase() === conn.account.toLowerCase()),
    category: labels.map((l) => CATEGORIES[l]).find(Boolean) ?? null,
    labels: labels.filter((l) => KEPT_LABELS.has(l)).map((l) => l.toLowerCase()),
    attachments: extractAttachments(p),
    bulk:
      Boolean(header(p, "List-Unsubscribe") || header(p, "List-Id")) ||
      ["bulk", "list", "junk"].includes(precedence),
    body: options.withBody ? extractBody(p) : null,
    rfcMessageId: header(p, "Message-ID"),
    references: header(p, "References"),
    url: webUrl(conn, `all/${m.threadId}`),
    provenance: {
      providerKey: "google",
      connectionId: conn.connectionId,
      externalId: m.id,
      source: conn.label,
      account: conn.account,
    },
  };
}

/** Gmail snippets are HTML-escaped. */
function decodeSnippet(snippet: string): string {
  return htmlToText(snippet);
}

export function normalizeThread(
  t: GThread,
  conn: GmailConnectionInfo,
  options: { withBody?: boolean } = {},
): EmailThread {
  const messages = (t.messages ?? [])
    .filter((m) => !(m.labelIds ?? []).includes("DRAFT"))
    .map((m) => normalizeMessage(m, conn, options))
    .sort((a, b) => a.date.localeCompare(b.date));
  return {
    id: makeExternalRef(conn.connectionId, "t", t.id),
    subject: messages[0]?.subject ?? "(no subject)",
    messages,
    url: webUrl(conn, `all/${t.id}`),
    provenance: {
      providerKey: "google",
      connectionId: conn.connectionId,
      externalId: t.id,
      source: conn.label,
      account: conn.account,
    },
  };
}

export function normalizeDraft(d: GDraft, conn: GmailConnectionInfo): EmailDraft {
  const p = d.message?.payload;
  return {
    id: makeExternalRef(conn.connectionId, "d", d.id),
    threadId: d.message?.threadId
      ? makeExternalRef(conn.connectionId, "t", d.message.threadId)
      : null,
    from: parseAddresses(header(p, "From"))[0]?.email ?? conn.account,
    to: parseAddresses(header(p, "To")),
    cc: parseAddresses(header(p, "Cc")),
    bcc: parseAddresses(header(p, "Bcc")),
    subject: header(p, "Subject") ?? "",
    body: (p ? rawBody(p) : null) ?? "",
    inReplyTo: header(p, "In-Reply-To"),
    references: header(p, "References"),
    url: webUrl(conn, "drafts"),
    provenance: {
      providerKey: "google",
      connectionId: conn.connectionId,
      externalId: d.id,
      source: conn.label,
      account: conn.account,
    },
  };
}

/** A draft's own text (no quote stripping: it is exactly what would be sent). */
function rawBody(payload: GPart): string | null {
  let plain: string | null = null;
  walk(payload, (p) => {
    if (!p.filename && p.body?.data && p.mimeType === "text/plain" && plain === null)
      plain = decodeBase64Url(p.body.data);
  });
  return plain === null ? null : (plain as string).replace(/\r\n/g, "\n").trim();
}

// ── Query and MIME building ──────────────────────────────────────────────────

/** Structured filters → Gmail search syntax. Values are stripped of grouping characters. */
export function buildGmailQuery(q: EmailQuery): string {
  const clean = (v: string) => v.replace(/[()"{}]/g, " ").trim();
  const parts: string[] = [];
  if (q.text) parts.push(clean(q.text));
  if (q.from) parts.push(`from:(${clean(q.from)})`);
  if (q.to) parts.push(`to:(${clean(q.to)})`);
  if (q.subject) parts.push(`subject:(${clean(q.subject)})`);
  if (q.after) parts.push(`after:${Math.floor(q.after.getTime() / 1000)}`);
  if (q.before) parts.push(`before:${Math.floor(q.before.getTime() / 1000)}`);
  if (q.unread === true) parts.push("is:unread");
  if (q.unread === false) parts.push("is:read");
  if (q.inInbox) parts.push("in:inbox");
  if (q.sent) parts.push("in:sent");
  if (q.hasAttachment) parts.push("has:attachment");
  if (q.category) parts.push(`category:${q.category}`);
  parts.push("-in:drafts");
  return parts.filter(Boolean).join(" ");
}

function assertSingleLine(value: string) {
  if (/[\r\n]/.test(value))
    throw new AppError("VALIDATION_ERROR", "Email headers must be a single line", {
      recovery: "review",
    });
  return value;
}

function encodeWord(text: string): string {
  return /^[\x20-\x7e]*$/.test(text)
    ? text
    : `=?UTF-8?B?${Buffer.from(text, "utf8").toString("base64")}?=`;
}

function formatAddress(a: EmailAddress): string {
  const email = assertSingleLine(a.email);
  if (!a.name) return email;
  const name = assertSingleLine(a.name);

  return /^[\x20-\x7e]*$/.test(name)
    ? `"${name.replace(/["\\]/g, "\\$&")}" <${email}>`
    : `${encodeWord(name)} <${email}>`;
}

/** RFC 5322 plain-text message, base64url-encoded for the Gmail API. */
export function buildRawMessage(draft: NewDraft, from: string | null): string {
  const headers: string[] = [];
  if (from) headers.push(`From: ${assertSingleLine(from)}`);
  headers.push(`To: ${draft.to.map(formatAddress).join(", ")}`);
  if (draft.cc.length) headers.push(`Cc: ${draft.cc.map(formatAddress).join(", ")}`);
  if (draft.bcc.length) headers.push(`Bcc: ${draft.bcc.map(formatAddress).join(", ")}`);
  headers.push(`Subject: ${encodeWord(assertSingleLine(draft.subject))}`);
  if (draft.reply?.inReplyTo)
    headers.push(`In-Reply-To: ${assertSingleLine(draft.reply.inReplyTo)}`);
  if (draft.reply?.references)
    headers.push(`References: ${assertSingleLine(draft.reply.references)}`);
  headers.push("MIME-Version: 1.0");
  headers.push('Content-Type: text/plain; charset="UTF-8"');
  headers.push("Content-Transfer-Encoding: base64");
  const body = Buffer.from(draft.body.replace(/\r?\n/g, "\r\n"), "utf8")
    .toString("base64")
    .replace(/.{76}/g, "$&\r\n");
  return Buffer.from(`${headers.join("\r\n")}\r\n\r\n${body}`, "utf8").toString("base64url");
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

// ── Provider ─────────────────────────────────────────────────────────────────

/** Gmail behind the Email capability. Ids in and out are ELISE refs scoped to this connection. */
export class GmailProvider implements EmailProvider {
  constructor(
    private readonly conn: GmailConnectionInfo,
    private readonly http: GoogleHttp,
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

  private metadataUrl(path: string): string {
    const params = new URLSearchParams({ format: "metadata" });
    for (const h of METADATA_HEADERS) params.append("metadataHeaders", h);
    return `${API}/${path}?${params}`;
  }

  private async messageMeta(id: string): Promise<GMessage | null> {
    return this.http.request<GMessage>(
      "GET",
      this.metadataUrl(`messages/${encodeURIComponent(id)}`),
      undefined,
      { notFoundAsNull: true },
    );
  }

  async search(query: EmailQuery): Promise<EmailMessage[]> {
    const params = new URLSearchParams({
      q: buildGmailQuery(query),
      maxResults: String(query.limit),
    });
    const list = await this.http.request<{ messages?: { id: string }[] }>(
      "GET",
      `${API}/messages?${params}`,
    );
    const metas = await mapLimit(list?.messages ?? [], CONCURRENCY, (m) => this.messageMeta(m.id));
    return metas
      .filter((m): m is GMessage => m !== null)
      .map((m) => normalizeMessage(m, this.conn));
  }

  async searchThreads(query: EmailQuery): Promise<EmailThread[]> {
    const params = new URLSearchParams({
      q: buildGmailQuery(query),
      maxResults: String(query.limit),
    });
    const list = await this.http.request<{ threads?: { id: string }[] }>(
      "GET",
      `${API}/threads?${params}`,
    );
    const threads = await mapLimit(list?.threads ?? [], CONCURRENCY, (t) =>
      this.http.request<GThread>(
        "GET",
        this.metadataUrl(`threads/${encodeURIComponent(t.id)}`),
        undefined,
        { notFoundAsNull: true },
      ),
    );
    return threads
      .filter((t): t is GThread => t !== null)
      .map((t) => normalizeThread(t, this.conn));
  }

  async getMessage(messageId: string): Promise<EmailMessage | null> {
    const id = this.parse(messageId, "m");
    const m = await this.http.request<GMessage>(
      "GET",
      `${API}/messages/${encodeURIComponent(id)}?format=full`,
      undefined,
      { notFoundAsNull: true },
    );
    return m ? normalizeMessage(m, this.conn, { withBody: true }) : null;
  }

  async peek(ids: string[]): Promise<EmailMessage[]> {
    const found = await mapLimit(ids, CONCURRENCY, async (ref) => {
      const kind = parseExternalRef(ref)?.parts[0] === "t" ? "t" : "m";
      if (kind === "m") return this.messageMeta(this.parse(ref, "m"));
      const t = await this.http.request<GThread>(
        "GET",
        this.metadataUrl(`threads/${encodeURIComponent(this.parse(ref, "t"))}`),
        undefined,
        { notFoundAsNull: true },
      );
      return t?.messages?.at(-1) ?? null;
    });
    return found
      .filter((m): m is GMessage => m !== null)
      .map((m) => normalizeMessage(m, this.conn));
  }

  async getThread(threadId: string): Promise<EmailThread | null> {
    const id = this.parse(threadId, "t");
    const t = await this.http.request<GThread>(
      "GET",
      `${API}/threads/${encodeURIComponent(id)}?format=full`,
      undefined,
      { notFoundAsNull: true },
    );
    return t ? normalizeThread(t, this.conn, { withBody: true }) : null;
  }

  async getDraft(draftId: string): Promise<EmailDraft | null> {
    const id = this.parse(draftId, "d");
    const d = await this.http.request<GDraft>(
      "GET",
      `${API}/drafts/${encodeURIComponent(id)}?format=full`,
      undefined,
      { notFoundAsNull: true },
    );
    return d ? normalizeDraft(d, this.conn) : null;
  }

  private draftBody(draft: NewDraft) {
    return {
      message: {
        raw: buildRawMessage(draft, this.conn.account),
        ...(draft.reply ? { threadId: this.parse(draft.reply.threadId, "t") } : {}),
      },
    };
  }

  /** Reads the draft back so callers see exactly what Gmail stored. */
  private async reread(created: GDraft | null): Promise<EmailDraft> {
    if (!created?.id) throw new AppError("PROVIDER_UNAVAILABLE", "Gmail did not return the draft");
    const draft = await this.getDraft(makeExternalRef(this.conn.connectionId, "d", created.id));
    if (!draft) throw new AppError("PROVIDER_UNAVAILABLE", "Gmail did not return the draft");
    return draft;
  }

  async createDraft(draft: NewDraft): Promise<EmailDraft> {
    return this.reread(
      await this.http.request<GDraft>("POST", `${API}/drafts`, this.draftBody(draft)),
    );
  }

  async updateDraft(draftId: string, draft: NewDraft): Promise<EmailDraft> {
    const id = this.parse(draftId, "d");
    return this.reread(
      await this.http.request<GDraft>("PUT", `${API}/drafts/${encodeURIComponent(id)}`, {
        id,
        ...this.draftBody(draft),
      }),
    );
  }

  async sendDraft(draftId: string): Promise<EmailMessage> {
    const id = this.parse(draftId, "d");
    const sent = await this.http.request<GMessage>("POST", `${API}/drafts/send`, { id });
    if (!sent?.id) {
      throw new AppError("UNKNOWN_OUTCOME", "Gmail did not confirm the email was sent", {
        recovery: "review",
      });
    }
    return normalizeMessage(sent, this.conn);
  }

  async deleteDraft(draftId: string): Promise<void> {
    const id = this.parse(draftId, "d");
    await this.http.request("DELETE", `${API}/drafts/${encodeURIComponent(id)}`);
  }

  async modify(ids: string[], change: { archive?: boolean; read?: boolean }): Promise<void> {
    const add: string[] = [];
    const remove: string[] = [];
    if (change.archive) remove.push("INBOX");
    if (change.read === true) remove.push("UNREAD");
    if (change.read === false) add.push("UNREAD");
    const labels = { addLabelIds: add, removeLabelIds: remove };

    const messages: string[] = [];
    const threads: string[] = [];
    for (const ref of ids) {
      if (parseExternalRef(ref)?.parts[0] === "t") threads.push(this.parse(ref, "t"));
      else messages.push(this.parse(ref, "m"));
    }
    if (messages.length) {
      await this.http.request("POST", `${API}/messages/batchModify`, { ids: messages, ...labels });
    }
    await mapLimit(threads, CONCURRENCY, (id) =>
      this.http.request("POST", `${API}/threads/${encodeURIComponent(id)}/modify`, labels),
    );
  }
}

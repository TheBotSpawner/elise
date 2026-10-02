import { z } from "zod";

import { destinationField } from "../providers/destination";
import type { ProviderKey } from "../providers/types";
import { isIsoDate } from "../time";

/**
 * Canonical Email model (docs/architecture/07 §24). Gmail (and future Outlook) map into this;
 * nothing here knows a provider's API. Messages and threads are distinct: thread context is
 * what "summarize this conversation" and "needs reply" reason over.
 */
export interface EmailAddress {
  email: string;
  name: string | null;
}

export interface EmailProvenance {
  providerKey: ProviderKey;
  connectionId: string;
  /** Provider message/draft id. */
  externalId: string;
  /** User-facing account name ("Personal", "Acme"). */
  source: string;
  /** Address of the account the item lives in. */
  account: string | null;
}

export interface EmailAttachment {
  filename: string;
  mimeType: string;
  size: number;
}

/** Well-known categories the provider can filter by (Gmail tabs). */
export const EMAIL_CATEGORIES = ["primary", "promotions", "social", "updates", "forums"] as const;
export type EmailCategory = (typeof EMAIL_CATEGORIES)[number];

export interface EmailMessage {
  /** Canonical message id (connection-scoped ref). */
  id: string;
  /** Canonical thread id (connection-scoped ref). */
  threadId: string;
  from: EmailAddress | null;
  to: EmailAddress[];
  cc: EmailAddress[];
  replyTo: EmailAddress[];
  subject: string;
  snippet: string;
  /** RFC 3339 instant. */
  date: string;
  unread: boolean;
  inInbox: boolean;
  /** The provider marked it important. */
  important: boolean;
  /** Sent from the connected account itself. */
  fromMe: boolean;
  category: EmailCategory | null;
  /** Provider labels needed for product behavior (user labels by name). */
  labels: string[];
  attachments: EmailAttachment[];
  /** Mailing-list / bulk markers from headers (List-Unsubscribe, Precedence). */
  bulk: boolean;
  /** Plain-text body; only present when the full message was fetched. Untrusted data. */
  body: string | null;
  /** RFC 5322 Message-ID and References, for correct threading of replies. */
  rfcMessageId: string | null;
  references: string | null;
  url: string | null;
  provenance: EmailProvenance;
}

export interface EmailThread {
  id: string;
  subject: string;
  /** Oldest first. */
  messages: EmailMessage[];
  url: string | null;
  provenance: EmailProvenance;
}

export interface EmailDraft {
  /** Canonical draft id (connection-scoped ref). */
  id: string;
  /** Thread the draft replies in, if any. */
  threadId: string | null;
  from: string | null;
  to: EmailAddress[];
  cc: EmailAddress[];
  bcc: EmailAddress[];
  subject: string;
  body: string;
  /** Reply threading headers, kept so edits stay in the same conversation. */
  inReplyTo: string | null;
  references: string | null;
  url: string | null;
  provenance: EmailProvenance;
}

export interface EmailQuery {
  /** Free keywords (subject/body). */
  text?: string;
  from?: string;
  to?: string;
  subject?: string;
  /** UTC instants. */
  after?: Date;
  before?: Date;
  unread?: boolean;
  inInbox?: boolean;
  sent?: boolean;
  hasAttachment?: boolean;
  category?: EmailCategory;
  limit: number;
}

export interface NewDraft {
  to: EmailAddress[];
  cc: EmailAddress[];
  bcc: EmailAddress[];
  subject: string;
  body: string;
  /** Reply threading: provider thread + RFC headers of the message replied to. */
  reply?: { threadId: string; inReplyTo: string | null; references: string | null } | null;
}

/** Contract every Email provider implements. Ids are canonical refs from this provider. */
export interface EmailProvider {
  /** Metadata only (no bodies), newest first. */
  search(query: EmailQuery): Promise<EmailMessage[]>;
  /** Threads matching a query with their messages' metadata (no bodies), newest first. */
  searchThreads(query: EmailQuery): Promise<EmailThread[]>;
  getMessage(messageId: string): Promise<EmailMessage | null>;
  /** Metadata for message ids, or each thread's latest message for thread ids. */
  peek(ids: string[]): Promise<EmailMessage[]>;
  /** Full thread with bodies, oldest message first. */
  getThread(threadId: string): Promise<EmailThread | null>;
  getDraft(draftId: string): Promise<EmailDraft | null>;
  createDraft(draft: NewDraft): Promise<EmailDraft>;
  updateDraft(draftId: string, draft: NewDraft): Promise<EmailDraft>;
  /** Sends an existing draft. Resolves only once the provider confirmed the send. */
  sendDraft(draftId: string): Promise<EmailMessage>;
  deleteDraft(draftId: string): Promise<void>;
  /** Message or thread ids from this provider. */
  modify(ids: string[], change: { archive?: boolean; read?: boolean }): Promise<void>;
}

// ── Model-facing inputs ──────────────────────────────────────────────────────

const ref = z.string().trim().min(1).max(1000);
/** Header values must never carry line breaks (header injection). */
const headerText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine((v) => !/[\r\n]/.test(v), "Must be a single line");
const address = z.email().max(320);
const date = z.string().refine(isIsoDate, "Expected YYYY-MM-DD");

export const searchInput = z
  .object({
    text: headerText(200).optional().describe("Keywords to find in the subject or body."),
    from: headerText(200).optional().describe("Sender name or email."),
    to: headerText(200).optional().describe("Recipient name or email."),
    subject: headerText(200).optional(),
    after: date.optional().describe("Received on or after this local date (YYYY-MM-DD)."),
    before: date.optional().describe("Received before this local date (YYYY-MM-DD), exclusive."),
    unread: z.boolean().optional(),
    inInbox: z.boolean().optional().describe("Only messages still in the inbox."),
    sent: z.boolean().optional().describe("Only messages the user sent."),
    hasAttachment: z.boolean().optional(),
    category: z.enum(EMAIL_CATEGORIES).optional().describe("Gmail-style inbox tab."),
    limit: z.number().int().min(1).max(50).default(15),
    destination: destinationField,
  })
  .strict();

export const listRecentInput = z
  .object({
    unreadOnly: z.boolean().default(false),
    days: z.number().int().min(1).max(30).default(7),
    limit: z.number().int().min(1).max(50).default(15),
    destination: destinationField,
  })
  .strict();

export const messageIdInput = z.object({ messageId: ref }).strict();
export const threadIdInput = z.object({ threadId: ref }).strict();

export const followUpsInput = z
  .object({
    kind: z
      .enum(["needs_reply", "waiting_on_others"])
      .describe(
        "needs_reply: people waiting on the user. waiting_on_others: the user wrote last and nobody answered.",
      ),
    days: z.number().int().min(1).max(30).default(14).describe("How far back to look."),
    olderThanHours: z
      .number()
      .int()
      .min(0)
      .max(720)
      .default(24)
      .describe("For waiting_on_others: only threads where the user's last message is this old."),
    limit: z.number().int().min(1).max(25).default(10),
    destination: destinationField,
  })
  .strict();

const recipients = z.array(address).max(50);

export const createDraftInput = z
  .object({
    to: recipients.min(1),
    cc: recipients.optional(),
    bcc: recipients.optional(),
    subject: headerText(300).pipe(z.string().min(1)),
    body: z.string().trim().min(1).max(20000),
    destination: destinationField,
  })
  .strict();

export const replyInput = z
  .object({
    messageId: ref.describe("The message being answered (from email.search/getThread)."),
    body: z.string().trim().min(1).max(20000),
    replyAll: z.boolean().default(false).describe("Only when the user asks to reply to everyone."),
  })
  .strict();

export const updateDraftInput = z
  .object({
    draftId: ref,
    to: recipients.min(1).optional(),
    cc: recipients.optional(),
    bcc: recipients.optional(),
    subject: headerText(300).pipe(z.string().min(1)).optional(),
    body: z.string().trim().min(1).max(20000).optional(),
  })
  .strict();

export const draftIdInput = z.object({ draftId: ref }).strict();

/** `version` is pinned by ELISE when the send is approved; the model never needs to set it. */
export const sendDraftInput = z
  .object({ draftId: ref, version: z.string().max(128).optional() })
  .strict();

export const modifyInput = z
  .object({
    ids: z
      .array(ref)
      .min(1)
      .max(100)
      .describe("Thread ids (preferred) or message ids from one account."),
  })
  .strict();

export type SearchInput = z.infer<typeof searchInput>;
export type FollowUpsInput = z.infer<typeof followUpsInput>;

// ── Deterministic rules ──────────────────────────────────────────────────────

const PUBLIC_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "yahoo.com",
  "icloud.com",
  "me.com",
  "proton.me",
  "protonmail.com",
]);

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

function uniqueAddresses(list: EmailAddress[], exclude: string[]): EmailAddress[] {
  const out: EmailAddress[] = [];
  for (const a of list) {
    if (exclude.some((e) => same(e, a.email))) continue;
    if (out.some((o) => same(o.email, a.email))) continue;
    out.push(a);
  }
  return out;
}

export interface ReplyRecipients {
  to: EmailAddress[];
  cc: EmailAddress[];
  /** People reply-all adds beyond a plain reply. */
  addedByReplyAll: EmailAddress[];
  /** Other thread participants a plain reply leaves out (so the user can decide). */
  leftOut: EmailAddress[];
}

/**
 * Who a reply goes to (RFC 5322 §3.6.3 conventions): Reply-To or From for a received message;
 * the original recipients when answering one's own message. Reply-all adds the other To/Cc.
 * The account's own address is never a recipient; Bcc cannot be known from received mail.
 */
export function replyRecipients(
  original: Pick<EmailMessage, "from" | "to" | "cc" | "replyTo" | "fromMe">,
  me: string | null,
  replyAll: boolean,
): ReplyRecipients {
  const mine = me ? [me] : [];
  const primary = original.fromMe
    ? original.to
    : original.replyTo.length
      ? original.replyTo
      : original.from
        ? [original.from]
        : [];
  const to = uniqueAddresses(primary, mine);
  const others = uniqueAddresses(
    [...(original.fromMe ? [] : original.to), ...original.cc],
    [...mine, ...to.map((a) => a.email)],
  );
  if (to.length === 0 && !replyAll) {
    return { to: others.slice(0, 1), cc: [], addedByReplyAll: [], leftOut: others.slice(1) };
  }
  return replyAll
    ? { to, cc: others, addedByReplyAll: others, leftOut: [] }
    : { to, cc: [], addedByReplyAll: [], leftOut: others };
}

export function replySubject(subject: string): string {
  return /^\s*(re|aw|rv)\s*:/i.test(subject) ? subject : `Re: ${subject}`.trim();
}

/** Recipients outside the account's organization (not flagged for consumer domains). */
export function externalRecipients(recipients: EmailAddress[], me: string | null): string[] {
  const domain = me?.split("@")[1]?.toLowerCase();
  if (!domain || PUBLIC_DOMAINS.has(domain)) return [];
  return recipients.map((r) => r.email).filter((e) => e.split("@")[1]?.toLowerCase() !== domain);
}

const NOREPLY = /(^|[._+-])(no-?reply|do-?not-?reply|notifications?|mailer-daemon|bounce)s?@/i;

/**
 * Deterministic "likely newsletter/automated" signal with its evidence. It only ever feeds
 * suggestions; nothing is archived or deleted because of it without the user's approval.
 */
export function noiseSignals(m: Pick<EmailMessage, "bulk" | "category" | "from">): string[] {
  const reasons: string[] = [];
  if (m.bulk) reasons.push("mailing-list headers");
  if (m.category && m.category !== "primary") reasons.push(`${m.category} tab`);
  if (m.from && NOREPLY.test(m.from.email)) reasons.push("automated sender");
  return reasons;
}

export interface FollowUp {
  threadId: string;
  subject: string;
  /** The person on the other side. */
  counterpart: string;
  lastMessageAt: string;
  lastMessageId: string;
  snippet: string;
  /** Explainable evidence, e.g. "latest message is from Alex · no later reply from you". */
  reasons: string[];
  confidence: "high" | "medium" | "low";
  source: string;
}

/**
 * Thread-direction heuristics for "needs reply" and "waiting on" (docs: keep it explainable).
 * Inputs are thread metadata; the model may refine the result, but these reasons stay attached.
 */
export function classifyFollowUp(
  thread: EmailThread,
  kind: FollowUpsInput["kind"],
  now: Date,
  olderThanHours: number,
): FollowUp | null {
  const last = thread.messages.at(-1);
  if (!last) return null;
  const reasons: string[] = [];
  let score = 0;

  if (kind === "needs_reply") {
    if (last.fromMe || !last.from) return null;
    if (noiseSignals(last).length > 0) return null;
    reasons.push(`latest message is from ${last.from.name ?? last.from.email}`);
    reasons.push("no later reply from you");
    const direct = last.to.length <= 3 && !last.bulk;
    if (direct) score++;
    if (/\?/.test(last.snippet)) {
      reasons.push("it asks a question");
      score++;
    }
    if (thread.messages.some((m) => m.fromMe)) {
      reasons.push("you already took part in this conversation");
      score++;
    }
    if (last.important) score++;
    return {
      ...base(thread, last, last.from),
      reasons,
      confidence: score >= 3 ? "high" : score >= 1 ? "medium" : "low",
    };
  }

  if (!last.fromMe) return null;
  const ageHours = (now.getTime() - new Date(last.date).getTime()) / 3_600_000;
  if (ageHours < olderThanHours) return null;
  const counterpart = last.to[0] ?? null;
  if (!counterpart) return null;
  reasons.push("your message is the latest in the conversation");
  reasons.push(`no answer for ${Math.floor(ageHours / 24)} day(s)`);
  if (/\?/.test(last.snippet)) {
    reasons.push("you asked a question");
    score++;
  }
  if (ageHours > 72) score++;
  return {
    ...base(thread, last, counterpart),
    reasons,
    confidence: score >= 2 ? "high" : "medium",
  };
}

function base(thread: EmailThread, last: EmailMessage, counterpart: EmailAddress) {
  return {
    threadId: thread.id,
    subject: thread.subject,
    counterpart: counterpart.name
      ? `${counterpart.name} <${counterpart.email}>`
      : counterpart.email,
    lastMessageAt: last.date,
    lastMessageId: last.id,
    snippet: last.snippet,
    source: thread.provenance.source,
  };
}

/**
 * Exact content that would be sent. A send approval pins this fingerprint; if the draft's
 * recipients, subject, body or thread change afterwards, the approval no longer applies.
 */
export async function draftFingerprint(draft: EmailDraft): Promise<string> {
  const norm = (list: EmailAddress[]) => list.map((a) => a.email.toLowerCase()).sort();
  const content = JSON.stringify({
    from: draft.from?.toLowerCase() ?? null,
    to: norm(draft.to),
    cc: norm(draft.cc),
    bcc: norm(draft.bcc),
    subject: draft.subject,
    body: draft.body.trim(),
    threadId: draft.threadId,
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Deterministic context budget: long bodies are cut before they reach the model. */
export function clip(text: string, max: number): string {
  const clean = text
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return clean.length <= max ? clean : `${clean.slice(0, max)}… [truncated]`;
}

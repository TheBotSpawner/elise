import { z } from "zod";

import { PERIODS, resolvePeriod, type PeriodPreset } from "../periods";
import { destinationField } from "../providers/destination";
import type { ProviderKey } from "../providers/types";
import { addDays, isIsoDate, isLocalDateTime, startOfDayUtc, zonedDateTimeToUtc } from "../time";

/**
 * Canonical Team Messaging (ADR-062): workspace conversations — channels, threads, direct
 * messages, reactions. Slack implements it today; Microsoft Teams can later. Nothing here knows a
 * provider's API. The provider stays the source of truth: ELISE asks it live and keeps no copy.
 */

/**
 * What a connection was allowed to reach, in product terms. The provider derives it from the
 * grant; a search never touches what isn't granted, and says so instead of failing.
 */
export const TEAM_ACCESS = [
  "public",
  "private",
  "direct",
  "files",
  "people",
  "send",
  "reactions",
] as const;
export type TeamAccess = (typeof TEAM_ACCESS)[number];

export interface TeamProvenance {
  providerKey: ProviderKey;
  connectionId: string;
  /** The connection's alias ("Trabajo"). */
  source: string;
  /** The provider's own workspace name ("Acme Inc"). */
  workspace: string;
}

export interface TeamPerson {
  /** Canonical person ref (connection-scoped). */
  id: string;
  name: string;
  handle: string | null;
  title: string | null;
  avatar: string | null;
  provenance: TeamProvenance;
}

export type TeamChannelKind = "public" | "private" | "direct" | "group";

export interface TeamChannel {
  /** Canonical channel ref. */
  id: string;
  /** "marketing", or the person's name for a direct conversation. */
  name: string;
  kind: TeamChannelKind;
  topic: string | null;
  url: string | null;
  provenance: TeamProvenance;
}

export interface TeamFile {
  id: string;
  title: string;
  fileType: string | null;
  url: string | null;
  /** RFC 3339. */
  date: string | null;
  author: string | null;
  provenance: TeamProvenance;
}

export interface TeamMessage {
  /** Canonical message ref. */
  id: string;
  /** The thread this message starts or belongs to; null for a plain channel message. */
  threadId: string | null;
  channel: { id: string; name: string | null; kind: TeamChannelKind | null };
  author: { id: string | null; name: string; avatar: string | null; bot: boolean };
  /** Plain text. Untrusted, third-party data. */
  text: string;
  /** RFC 3339 instant. */
  date: string;
  /** Replies under this message when it starts a thread (null: unknown). */
  replyCount: number | null;
  files: { title: string; fileType: string | null; url: string | null }[];
  /** The provider's permalink: what ELISE cites. */
  url: string | null;
  provenance: TeamProvenance;
}

export interface TeamThread {
  id: string;
  channel: TeamMessage["channel"];
  /** Oldest first, root included. */
  messages: TeamMessage[];
  /** More replies exist than were read (the read is bounded). */
  hasMore: boolean;
  url: string | null;
  provenance: TeamProvenance;
}

export interface TeamSearchQuery {
  /** The user's question or keywords. */
  text: string;
  /** A person ref, or a name/handle the provider resolves. */
  from?: string;
  /** A channel ref, or a channel name. */
  channel?: string;
  after?: Date;
  before?: Date;
  includeFiles: boolean;
  sort: "relevance" | "recent";
  limit: number;
}

export interface TeamSearchResult {
  messages: TeamMessage[];
  files: TeamFile[];
  /** Kinds of conversations not searched because the connection isn't allowed to read them. */
  notSearched: TeamAccess[];
}

export interface TeamWindow {
  after?: Date;
  before?: Date;
  limit: number;
}

/** Contract every Team Messaging provider implements. Ids are canonical refs from this provider. */
/** One conversation with messages the user hasn't read (ADR-099). */
export interface TeamUnread {
  channel: TeamChannel;
  /** Unread messages counted (from others); `more`: there are more than were read. */
  count: number;
  more: boolean;
  /** The newest few, newest first. */
  messages: TeamMessage[];
}

export interface TeamUnreadResult {
  conversations: TeamUnread[];
  /** Conversations checked, of how many the user is in (a bounded scan). */
  checked: number;
  total: number;
}

export interface TeamMessagingProvider {
  /** What this connection may reach (from its stored grant; no provider call). */
  access(): Promise<readonly TeamAccess[]>;
  search(query: TeamSearchQuery): Promise<TeamSearchResult>;
  /** Channels the user is in, optionally filtered by name; bounded. */
  listChannels(query: string | null, limit: number): Promise<TeamChannel[]>;
  findPeople(query: string, limit: number): Promise<TeamPerson[]>;
  /** Messages of one conversation in a time window, newest first; bounded. */
  getRecent(
    channelId: string,
    window: TeamWindow,
  ): Promise<{ messages: TeamMessage[]; hasMore: boolean }>;
  /** A thread from a thread or message ref (a reply resolves to its thread). */
  getThread(ref: string): Promise<TeamThread | null>;
  getMessage(messageId: string): Promise<TeamMessage | null>;
  /** The conversation a destination ref (channel or person) posts to. */
  destination(ref: string): Promise<TeamChannel>;
  /** Posts exactly `text`. Resolves only once the provider confirmed it. */
  post(input: { to: string; text: string; threadId: string | null }): Promise<TeamMessage>;
  react(messageId: string, emoji: string, on: boolean): Promise<void>;
  /** What arrived after the user last read each conversation, direct ones first; bounded. */
  unread(): Promise<TeamUnreadResult>;
}

// ── Model-facing inputs ──────────────────────────────────────────────────────

const ref = z.string().trim().min(1).max(500);
const localDate = z
  .string()
  .refine(
    (v) => isIsoDate(v) || isLocalDateTime(v),
    "Expected a local date YYYY-MM-DD or date-time YYYY-MM-DDTHH:mm",
  );
const WEEKDAYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;

/** Time, as the user said it; ELISE turns it into exact bounds in the user's timezone. */
const windowFields = {
  period: z
    .enum(PERIODS)
    .optional()
    .describe(
      '"hoy" → today, "ayer" → yesterday, "esta semana" → this_week, "el mes pasado" → last_month.',
    ),
  sinceWeekday: z
    .enum(WEEKDAYS)
    .optional()
    .describe('"desde el lunes" → monday (the most recent one, today included).'),
  after: localDate
    .optional()
    .describe("On or after this local date or date-time (YYYY-MM-DD or YYYY-MM-DDTHH:mm)."),
  before: localDate
    .optional()
    .describe(
      'Before this local date or date-time, exclusive ("antes de la reunión" → its start).',
    ),
};

export const searchInput = z
  .object({
    query: z
      .string()
      .trim()
      .min(1)
      .max(300)
      .describe("What to look for, in the user's words (a question works: semantic search)."),
    from: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .optional()
      .describe("Only messages by this person (name, @handle or a person id)."),
    channel: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .optional()
      .describe('Only this channel ("#marketing", "marketing" or a channel id).'),
    ...windowFields,
    includeFiles: z.boolean().default(false).describe("Also search shared files."),
    sort: z
      .enum(["relevance", "recent"])
      .default("relevance")
      .describe("recent for 'lo último que…', relevance otherwise."),
    limit: z.number().int().min(1).max(20).default(10),
    destination: destinationField,
    allWorkspaces: z
      .boolean()
      .default(false)
      .describe("Only when the user asks to search every connected workspace."),
  })
  .strict();

export const listChannelsInput = z
  .object({
    query: z.string().trim().min(1).max(80).optional().describe("Part of the channel's name."),
    limit: z.number().int().min(1).max(50).default(20),
    destination: destinationField,
  })
  .strict();

export const getRecentInput = z
  .object({
    channel: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .describe(
        'The channel ("#sales", "sales" or a channel id), or a person for a direct conversation.',
      ),
    ...windowFields,
    limit: z.number().int().min(1).max(50).default(20),
    destination: destinationField,
  })
  .strict();

export const threadInput = z
  .object({ id: ref.describe("A thread id or a message id from a Team Messaging result.") })
  .strict();
export const messageInput = z.object({ messageId: ref }).strict();

export const findUserInput = z
  .object({
    name: z.string().trim().min(1).max(120).describe("Name or @handle as the user said it."),
    limit: z.number().int().min(1).max(10).default(5),
    destination: destinationField,
  })
  .strict();

const text = z.string().trim().min(1).max(4000);

export const draftInput = z
  .object({
    to: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .describe(
        'Who or where: a person ("Rod", "@rod") or channel ("#sales"), or an id from a result.',
      ),
    text: text.describe("The exact message, in the user's words and language."),
    destination: destinationField,
  })
  .strict();

/**
 * `toLabel` is pinned by ELISE when the destination is resolved; the approval covers exactly this
 * destination and text, so nothing can change between what the user approved and what is sent.
 */
export const sendInput = draftInput.extend({ toLabel: z.string().max(300).optional() }).strict();

export const replyInput = z
  .object({
    id: ref.describe("The thread id, or the id of a message in it."),
    text: text.describe("The exact reply, in the user's words and language."),
    toLabel: z.string().max(300).optional(),
  })
  .strict();

export const reactionInput = z
  .object({
    messageId: ref,
    emoji: z
      .string()
      .trim()
      .min(1)
      .max(60)
      .describe('An emoji ("👍") or its name ("thumbsup", "white_check_mark").'),
  })
  .strict();

export const saveInput = z
  .object({
    id: ref.describe("The thread or message to save."),
    space: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .describe('The Knowledge Space or Section the user named ("Trabajo").'),
    title: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

export type SearchInput = z.infer<typeof searchInput>;
type WindowInput = Pick<SearchInput, "period" | "sinceWeekday" | "after" | "before">;

// ── Deterministic rules ──────────────────────────────────────────────────────

/** A local date or date-time → the instant it starts, in the user's timezone. */
function localStart(value: string, timezone: string): Date {
  return isIsoDate(value) ? startOfDayUtc(value, timezone) : zonedDateTimeToUtc(value, timezone);
}

/**
 * "Hoy", "desde el lunes", "antes de la reunión" → exact instants in the user's timezone. Dates
 * are inclusive days ("ayer" covers all of yesterday); `before` is exclusive. The model passes
 * what the user said; it never computes an instant.
 */
export function searchWindow(
  input: WindowInput,
  today: string,
  timezone: string,
): { after?: Date; before?: Date } {
  let after: Date | undefined;
  let before: Date | undefined;
  if (input.period) {
    const p = resolvePeriod(input.period as PeriodPreset, today);
    after = startOfDayUtc(p.from, timezone);
    before = startOfDayUtc(addDays(p.to, 1), timezone);
  }
  if (input.sinceWeekday) {
    const wanted = WEEKDAYS.indexOf(input.sinceWeekday); // Monday = 0
    const current = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7;
    after = startOfDayUtc(addDays(today, -((current - wanted + 7) % 7)), timezone);
  }
  if (input.after) after = localStart(input.after, timezone);
  if (input.before) before = localStart(input.before, timezone);
  return { ...(after ? { after } : {}), ...(before ? { before } : {}) };
}

/** How a conversation is named to people: "#sales", or a person's name for a direct one. */
export const channelLabel = (c: { name: string | null; kind: TeamChannelKind | null }) =>
  !c.name ? "?" : c.kind === "direct" || c.kind === "group" ? c.name : `#${c.name}`;

/** Channel names as people write them: "#Marketing" and "marketing" are the same. */
export const channelKey = (name: string) => name.trim().replace(/^#/, "").toLowerCase();

/** Person names without accents, case or @: "@Martín" finds "martin". */
export const personKey = (name: string) =>
  name.normalize("NFD").replace(/\p{M}/gu, "").replace(/^@/, "").toLowerCase().trim();

/**
 * Which people a name the user said refers to: exact names/handles first, then names that start
 * with it ("Martín" → "Martín Pérez"), then names containing it. Several equally good matches
 * are an ambiguity to ask about, never a guess.
 */
export function matchPeople<P extends Pick<TeamPerson, "name" | "handle">>(
  people: readonly P[],
  wanted: string,
): P[] {
  const w = personKey(wanted);
  if (!w) return [];
  const keys = (p: P) => [p.name, p.handle ?? ""].map(personKey).filter(Boolean);
  const exact = people.filter((p) => keys(p).includes(w));
  if (exact.length) return exact;
  const prefix = people.filter((p) =>
    keys(p).some((k) => k.split(/\s+/).some((part) => part === w) || k.startsWith(w)),
  );
  if (prefix.length) return prefix;
  return w.length >= 3 ? people.filter((p) => keys(p).some((k) => k.includes(w))) : [];
}

/** Deterministic context budget for third-party text. */
export function clipMessage(text: string, max: number): string {
  const clean = text
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return clean.length <= max ? clean : `${clean.slice(0, max)}… [truncated]`;
}

/** Newest first, de-duplicated by message id (several workspaces or pages merged). */
export function mergeMessages(lists: readonly TeamMessage[][]): TeamMessage[] {
  const seen = new Map<string, TeamMessage>();
  for (const m of lists.flat()) if (!seen.has(m.id)) seen.set(m.id, m);
  return [...seen.values()].sort((a, b) => b.date.localeCompare(a.date));
}

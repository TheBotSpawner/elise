import type {
  TeamAccess,
  TeamChannel,
  TeamChannelKind,
  TeamFile,
  TeamMessage,
  TeamMessagingProvider,
  TeamPerson,
  TeamProvenance,
  TeamSearchQuery,
  TeamSearchResult,
  TeamThread,
  TeamWindow,
} from "@/core/capabilities/team-messaging";
import { channelKey, matchPeople } from "@/core/capabilities/team-messaging";
import { AppError } from "@/core/errors";
import { makeExternalRef, parseExternalRef } from "@/core/providers/refs";

import type { SlackHttp } from "./http";
import { grantedAccess, LEGACY_SEARCH_SCOPE } from "./oauth";

/**
 * Slack as a Team Messaging provider (ADR-062), over the Web API with the connected user's own
 * token. Search is Slack's Real-time Search (assistant.search.context); a thread or a channel
 * window is read only when asked for (conversations.replies / .history), one bounded page each.
 * Nothing is stored: results live in this request only.
 *
 * Refs (connection-scoped): m:<channel>:<ts>[:<thread ts>] message · t:<channel>:<thread ts>
 * thread · c:<channel> conversation · u:<user> person.
 */

/** Slack's own Marketplace rules: unlisted distributed apps read at most 15 messages per call. */
const UNLISTED_PAGE = 15;
const PAGE = 50;
/** Channels and people read per request, at most (pages of 200). */
const LIST_PAGES = 3;
const PEOPLE_PAGES = 5;

export interface SlackConnection {
  connectionId: string;
  /** The connection's alias in ELISE ("Firbot"). */
  label: string;
  /** Distributed but not Marketplace-listed: legacy search and small history pages. */
  unlisted: boolean;
}

interface RtsMessage {
  author_name?: string;
  author_user_id?: string;
  channel_id?: string;
  channel_name?: string;
  message_ts?: string;
  content?: string;
  is_author_bot?: boolean;
  permalink?: string;
}
interface RtsFile {
  file_id?: string;
  title?: string;
  file_type?: string;
  permalink?: string;
  date_created?: number;
  author_name?: string;
}
interface SlackMessage {
  ts: string;
  user?: string;
  username?: string;
  bot_id?: string;
  text?: string;
  thread_ts?: string;
  reply_count?: number;
  subtype?: string;
  files?: { title?: string; name?: string; filetype?: string; permalink?: string }[];
  bot_profile?: { name?: string };
}
interface SlackChannel {
  id: string;
  name?: string;
  user?: string;
  is_im?: boolean;
  is_mpim?: boolean;
  is_private?: boolean;
  topic?: { value?: string };
}
interface SlackUser {
  id: string;
  name?: string;
  deleted?: boolean;
  is_bot?: boolean;
  real_name?: string;
  profile?: { display_name?: string; real_name?: string; title?: string; image_48?: string };
}
interface LegacyMatch {
  ts: string;
  text?: string;
  user?: string;
  username?: string;
  permalink?: string;
  channel?: {
    id?: string;
    name?: string;
    is_private?: boolean;
    is_im?: boolean;
    is_mpim?: boolean;
  };
}

/** "1712345678.123456" → RFC 3339. */
const tsDate = (ts: string) => new Date(Number(ts) * 1000).toISOString();
const unix = (d: Date) => Math.floor(d.getTime() / 1000);
const https = (url: string | undefined | null) => (url && url.startsWith("https://") ? url : null);

/** A reply's permalink carries its thread: ".../p1712...?thread_ts=1712345678.123456&cid=C1". */
export function threadTsFromPermalink(permalink: string | undefined): string | null {
  if (!permalink) return null;
  try {
    return new URL(permalink).searchParams.get("thread_ts");
  } catch {
    return null;
  }
}

/**
 * Slack message markup → readable text: <@U1> → @name, <#C1|sales> → #sales, <url|label> →
 * label (url), entities decoded. The text stays third-party data.
 */
export function plainText(text: string, name: (userId: string) => string | null): string {
  return text
    .replace(
      /<@([UW][A-Z0-9]+)(?:\|([^>]+))?>/g,
      (_, id: string, label?: string) => `@${label ?? name(id) ?? id}`,
    )
    .replace(
      /<#([CGD][A-Z0-9]+)(?:\|([^>]*))?>/g,
      (_, id: string, label?: string) => `#${label || id}`,
    )
    .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, "@$1")
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, "$2 ($1)")
    .replace(/<(https?:[^>]+)>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

const COMMON_EMOJI: Record<string, string> = {
  "👍": "+1",
  "👎": "-1",
  "❤️": "heart",
  "❤": "heart",
  "😂": "joy",
  "🎉": "tada",
  "✅": "white_check_mark",
  "👀": "eyes",
  "🙏": "pray",
  "🔥": "fire",
  "😄": "smile",
  "🙂": "slightly_smiling_face",
  "👏": "clap",
  "🚀": "rocket",
  "💯": "100",
  "😮": "open_mouth",
  "😢": "cry",
  "👌": "ok_hand",
  "💪": "muscle",
  "🤔": "thinking_face",
};

/** "👍", ":thumbsup:" or "thumbsup" → Slack's reaction name. */
export function emojiName(emoji: string): string {
  const e = emoji.trim();
  if (COMMON_EMOJI[e]) return COMMON_EMOJI[e];
  const name = e.replace(/^:|:$/g, "").toLowerCase();
  if (!/^[a-z0-9_+'-]{1,60}$/.test(name))
    throw new AppError("VALIDATION_ERROR", `Use the emoji's name (e.g. "thumbsup") for ${e}`, {
      recovery: "review",
    });
  return name;
}

export class SlackProvider implements TeamMessagingProvider {
  private scopeCache: Promise<string[]> | null = null;
  private teamCache: Promise<{ team: string; url: string | null; userId: string | null }> | null =
    null;
  private channelsCache: Promise<SlackChannel[]> | null = null;
  private peopleCache: Promise<SlackUser[]> | null = null;
  private readonly names = new Map<string, string>();

  constructor(
    private readonly conn: SlackConnection,
    private readonly http: Pick<SlackHttp, "call">,
    /** The scopes Slack granted this connection (from the encrypted vault). */
    private readonly grantedScopes: () => Promise<string[]>,
  ) {}

  // ── Grant and identity ─────────────────────────────────────────────────────

  private scopes() {
    return (this.scopeCache ??= this.grantedScopes());
  }

  async access(): Promise<readonly TeamAccess[]> {
    return grantedAccess(await this.scopes());
  }

  /** Workspace name, its URL (for permalinks) and the user's id: one auth.test per request. */
  private team() {
    return (this.teamCache ??= this.http
      .call<{ team?: string; url?: string; user_id?: string }>("auth.test", {})
      .then((r) => ({
        team: r.team ?? this.conn.label,
        url: https(r.url),
        userId: r.user_id ?? null,
      })));
  }

  private async provenance(): Promise<TeamProvenance> {
    return {
      providerKey: "slack",
      connectionId: this.conn.connectionId,
      source: this.conn.label,
      workspace: (await this.team()).team,
    };
  }

  private get page() {
    return this.conn.unlisted ? UNLISTED_PAGE : PAGE;
  }

  // ── Refs ───────────────────────────────────────────────────────────────────

  private ref(...parts: string[]) {
    return makeExternalRef(this.conn.connectionId, ...parts);
  }

  /** A ref from this connection, or NOT_FOUND (a ref never reaches another workspace). */
  private parse(
    ref: string,
    kinds: string[],
  ): { kind: string; a: string; b: string | null; c: string | null } {
    const p = parseExternalRef(ref);
    if (
      !p ||
      p.connectionId !== this.conn.connectionId ||
      !kinds.includes(p.parts[0] ?? "") ||
      !p.parts[1]
    )
      throw new AppError("NOT_FOUND", "That Slack item isn't in this workspace", {
        recovery: "review",
      });
    return { kind: p.parts[0]!, a: p.parts[1], b: p.parts[2] ?? null, c: p.parts[3] ?? null };
  }

  /** The thread a message ref belongs to (its own ts when it starts one or has none yet). */
  private threadOf(ref: string): { channel: string; ts: string } {
    const r = this.parse(ref, ["t", "m"]);
    if (r.kind === "t") return { channel: r.a, ts: r.b! };
    return { channel: r.a, ts: r.c ?? r.b! };
  }

  private messageRef(channel: string, ts: string, threadTs: string | null) {
    return threadTs && threadTs !== ts
      ? this.ref("m", channel, ts, threadTs)
      : this.ref("m", channel, ts);
  }

  /** Permalink built from the workspace URL: no extra call per message. */
  private async permalink(channel: string, ts: string, threadTs: string | null) {
    const base = (await this.team()).url;
    if (!base) return null;
    const p = `${base.replace(/\/$/, "")}/archives/${channel}/p${ts.replace(".", "")}`;
    return threadTs && threadTs !== ts ? `${p}?thread_ts=${threadTs}&cid=${channel}` : p;
  }

  // ── People and channels (bounded, cached per request) ──────────────────────

  private people() {
    return (this.peopleCache ??= (async () => {
      const out: SlackUser[] = [];
      let cursor: string | undefined;
      // ponytail: reads up to 1,000 people per request; very large workspaces would use
      // Real-time Search's user results instead.
      for (let i = 0; i < PEOPLE_PAGES; i++) {
        const r = await this.http.call<{
          members?: SlackUser[];
          response_metadata?: { next_cursor?: string };
        }>("users.list", { limit: 200, cursor });
        out.push(...(r.members ?? []));
        cursor = r.response_metadata?.next_cursor || undefined;
        if (!cursor) break;
      }
      for (const u of out) this.names.set(u.id, displayName(u));
      return out.filter((u) => !u.deleted && !u.is_bot && u.id !== "USLACKBOT");
    })());
  }

  private async nameOf(userId: string): Promise<string> {
    const known = this.names.get(userId);
    if (known) return known;
    try {
      const r = await this.http.call<{ user?: SlackUser }>("users.info", { user: userId });
      const name = r.user ? displayName(r.user) : userId;
      this.names.set(userId, name);
      return name;
    } catch {
      return userId;
    }
  }

  /** People mentioned in these texts, named once per request (at most 15 lookups). */
  private async learnMentions(texts: (string | undefined)[]) {
    const ids = new Set<string>();
    for (const t of texts)
      for (const m of (t ?? "").matchAll(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g)) ids.add(m[1]!);
    await Promise.all(
      [...ids]
        .filter((id) => !this.names.has(id))
        .slice(0, 15)
        .map((id) => this.nameOf(id)),
    );
  }

  private async person(u: SlackUser): Promise<TeamPerson> {
    return {
      id: this.ref("u", u.id),
      name: displayName(u),
      handle: u.name ?? null,
      title: u.profile?.title || null,
      avatar: https(u.profile?.image_48),
      provenance: await this.provenance(),
    };
  }

  async findPeople(query: string, limit: number): Promise<TeamPerson[]> {
    const all = (await this.people()).map((u) => ({
      u,
      name: displayName(u),
      handle: u.name ?? null,
    }));
    const found = matchPeople(all, query).slice(0, limit);
    return Promise.all(found.map((x) => this.person(x.u)));
  }

  /** Conversations the user is in, of the kinds this grant can read. */
  private async channels(): Promise<SlackChannel[]> {
    return (this.channelsCache ??= (async () => {
      const access = await this.access();
      const types = [
        "public_channel",
        ...(access.includes("private") ? ["private_channel"] : []),
        ...(access.includes("direct") ? ["im", "mpim"] : []),
      ];
      const out: SlackChannel[] = [];
      let cursor: string | undefined;
      for (let i = 0; i < LIST_PAGES; i++) {
        const r = await this.http.call<{
          channels?: SlackChannel[];
          response_metadata?: { next_cursor?: string };
        }>("users.conversations", {
          types: types.join(","),
          exclude_archived: true,
          limit: 200,
          cursor,
        });
        out.push(...(r.channels ?? []));
        cursor = r.response_metadata?.next_cursor || undefined;
        if (!cursor) break;
      }
      return out;
    })());
  }

  private async channel(c: SlackChannel): Promise<TeamChannel> {
    const kind = kindOf(c);
    const name = c.is_im && c.user ? await this.nameOf(c.user) : (c.name ?? c.id);
    const base = (await this.team()).url;
    return {
      id: this.ref("c", c.id),
      name,
      kind,
      topic: c.topic?.value || null,
      url: base ? `${base.replace(/\/$/, "")}/archives/${c.id}` : null,
      provenance: await this.provenance(),
    };
  }

  async listChannels(query: string | null, limit: number): Promise<TeamChannel[]> {
    const wanted = query ? channelKey(query) : null;
    const all = (await this.channels()).filter((c) => !c.is_im);
    const exact = wanted ? all.filter((c) => channelKey(c.name ?? "") === wanted) : [];
    const rest = wanted
      ? all.filter((c) => !exact.includes(c) && channelKey(c.name ?? "").includes(wanted))
      : all;
    return Promise.all([...exact, ...rest].slice(0, limit).map((c) => this.channel(c)));
  }

  async destination(ref: string): Promise<TeamChannel> {
    const r = this.parse(ref, ["c", "u", "m", "t"]);
    if (r.kind === "u") {
      const name = await this.nameOf(r.a);
      return {
        id: ref,
        name,
        kind: "direct",
        topic: null,
        url: null,
        provenance: await this.provenance(),
      };
    }
    const known = (await this.channels()).find((c) => c.id === r.a);
    if (known) return this.channel(known);
    const info = await this.http.call<{ channel: SlackChannel }>("conversations.info", {
      channel: r.a,
    });
    return this.channel(info.channel);
  }

  /** A person's direct conversation, for reading it (posting opens it when needed). */
  private async directChannelOf(userId: string): Promise<string> {
    const dm = (await this.channels()).find((c) => c.is_im && c.user === userId);
    if (!dm)
      throw new AppError(
        "NOT_FOUND",
        "There's no direct conversation with that person that ELISE can read",
        {
          recovery: "review",
        },
      );
    return dm.id;
  }

  // ── Messages ───────────────────────────────────────────────────────────────

  private async message(
    channel: { id: string; name: string | null; kind: TeamChannelKind | null },
    m: SlackMessage,
    url?: string | null,
  ): Promise<TeamMessage> {
    const threadTs = m.thread_ts ?? null;
    const isThread = Boolean(threadTs) || Boolean(m.reply_count);
    const author = m.user
      ? await this.nameOf(m.user)
      : (m.bot_profile?.name ?? m.username ?? "Slack");
    return {
      id: this.messageRef(channel.id, m.ts, threadTs),
      threadId: isThread ? this.ref("t", channel.id, threadTs ?? m.ts) : null,
      channel: { id: this.ref("c", channel.id), name: channel.name, kind: channel.kind },
      author: {
        id: m.user ? this.ref("u", m.user) : null,
        name: author,
        avatar: null,
        bot: Boolean(m.bot_id),
      },
      text: plainText(m.text ?? "", (id) => this.names.get(id) ?? null),
      date: tsDate(m.ts),
      replyCount: m.reply_count ?? null,
      files: (m.files ?? []).map((f) => ({
        title: f.title ?? f.name ?? "file",
        fileType: f.filetype ?? null,
        url: https(f.permalink),
      })),
      url: url ?? (await this.permalink(channel.id, m.ts, threadTs)),
      provenance: await this.provenance(),
    };
  }

  private async channelInfo(id: string) {
    const c = (await this.channels()).find((x) => x.id === id);
    if (c)
      return {
        id,
        name: c.is_im && c.user ? await this.nameOf(c.user) : (c.name ?? null),
        kind: kindOf(c),
      };
    return { id, name: null, kind: id.startsWith("D") ? ("direct" as const) : null };
  }

  /** Real people's messages only: joins, topic changes and other system lines are skipped. */
  private conversational(list: SlackMessage[]) {
    return list.filter(
      (m) =>
        !m.subtype ||
        ["bot_message", "thread_broadcast", "file_share", "me_message"].includes(m.subtype),
    );
  }

  async getRecent(channelId: string, window: TeamWindow) {
    const r = this.parse(channelId, ["c", "u"]);
    const id = r.kind === "u" ? await this.directChannelOf(r.a) : r.a;
    const res = await this.http.call<{ messages?: SlackMessage[]; has_more?: boolean }>(
      "conversations.history",
      {
        channel: id,
        limit: Math.min(window.limit, this.page),
        ...(window.after ? { oldest: String(unix(window.after)) } : {}),
        ...(window.before ? { latest: String(unix(window.before)) } : {}),
        inclusive: true,
      },
    );
    const info = await this.channelInfo(id);
    await this.learnMentions((res.messages ?? []).map((m) => m.text));
    const messages = await Promise.all(
      this.conversational(res.messages ?? []).map((m) => this.message(info, m)),
    );
    return { messages, hasMore: Boolean(res.has_more) };
  }

  async getThread(ref: string): Promise<TeamThread | null> {
    const t = this.threadOf(ref);
    let res: { messages?: SlackMessage[]; has_more?: boolean };
    try {
      res = await this.http.call("conversations.replies", {
        channel: t.channel,
        ts: t.ts,
        limit: this.page,
      });
    } catch (error) {
      if (error instanceof AppError && error.code === "NOT_FOUND") return null;
      throw error;
    }
    const list = res.messages ?? [];
    if (!list.length) return null;
    const root = list[0]!;
    const threadTs = root.thread_ts ?? root.ts;
    const info = await this.channelInfo(t.channel);
    await this.learnMentions(list.map((m) => m.text));
    const messages = await Promise.all(this.conversational(list).map((m) => this.message(info, m)));
    return {
      id: this.ref("t", t.channel, threadTs),
      channel: { id: this.ref("c", t.channel), name: info.name, kind: info.kind },
      messages,
      hasMore: Boolean(res.has_more),
      url: await this.permalink(t.channel, threadTs, null),
      provenance: await this.provenance(),
    };
  }

  async getMessage(messageId: string): Promise<TeamMessage | null> {
    const r = this.parse(messageId, ["m"]);
    const [channel, ts, threadTs] = [r.a, r.b!, r.c];
    const info = await this.channelInfo(channel);
    const res = threadTs
      ? await this.http.call<{ messages?: SlackMessage[] }>("conversations.replies", {
          channel,
          ts: threadTs,
          latest: ts,
          oldest: ts,
          inclusive: true,
          limit: 2,
        })
      : await this.http.call<{ messages?: SlackMessage[] }>("conversations.history", {
          channel,
          latest: ts,
          oldest: ts,
          inclusive: true,
          limit: 1,
        });
    const m = (res.messages ?? []).find((x) => x.ts === ts);
    return m ? this.message(info, m) : null;
  }

  // ── Search ─────────────────────────────────────────────────────────────────

  async search(q: TeamSearchQuery): Promise<TeamSearchResult> {
    const scopes = await this.scopes();
    const access = grantedAccess(scopes);
    const notSearched: TeamAccess[] = (["private", "direct"] as const).filter(
      (a) => !access.includes(a),
    );
    if (q.includeFiles && !access.includes("files")) notSearched.push("files");
    const rts = scopes.includes("search:read.public");
    const legacy = scopes.includes(LEGACY_SEARCH_SCOPE);
    if (rts && !this.conn.unlisted) {
      try {
        return { ...(await this.realtime(q, access)), notSearched };
      } catch (error) {
        // Slack doesn't offer Real-time Search to this app here: the documented fallback.
        const unavailable =
          error instanceof AppError && error.details?.reason === "search_unavailable";
        if (!unavailable || !legacy) throw error;
      }
    }
    if (!legacy)
      throw new AppError(
        "CAPABILITY_UNAVAILABLE",
        "Slack search isn't available for this workspace",
        {
          recovery: "review",
          details: { reason: "search_unavailable" },
        },
      );
    return { ...(await this.legacySearch(q, access)), notSearched };
  }

  /** `from` and `channel` as the user said them → Slack's <@U…> / <#C…> filters. */
  private async filters(q: TeamSearchQuery): Promise<{
    from: string | null;
    channel: string | null;
    fromName: string | null;
    channelName: string | null;
  }> {
    let from: string | null = null;
    let fromName: string | null = null;
    if (q.from) {
      const ref = parseExternalRef(q.from);
      if (ref?.parts[0] === "u" && ref.connectionId === this.conn.connectionId)
        from = ref.parts[1]!;
      else {
        const people = await this.findPeople(q.from, 5);
        if (people.length > 1)
          throw new AppError(
            "VALIDATION_ERROR",
            `Several people match "${q.from}": ${people.map((p) => p.name).join("; ")}. Ask which one.`,
            { recovery: "review", details: { reason: "ambiguous_destination" } },
          );
        if (!people.length)
          throw new AppError("NOT_FOUND", `Nobody called "${q.from}" in this workspace`, {
            recovery: "review",
          });
        from = this.parse(people[0]!.id, ["u"]).a;
        fromName = people[0]!.handle;
      }
    }
    let channel: string | null = null;
    let channelName: string | null = null;
    if (q.channel) {
      const ref = parseExternalRef(q.channel);
      if (ref?.parts[0] === "c" && ref.connectionId === this.conn.connectionId)
        channel = ref.parts[1]!;
      else {
        const found = (await this.channels()).find(
          (c) => channelKey(c.name ?? "") === channelKey(q.channel!),
        );
        if (!found)
          throw new AppError(
            "NOT_FOUND",
            `No channel called #${channelKey(q.channel)} that you're in`,
            { recovery: "review" },
          );
        channel = found.id;
        channelName = found.name ?? null;
      }
    }
    return { from, channel, fromName, channelName };
  }

  private async realtime(q: TeamSearchQuery, access: TeamAccess[]) {
    const f = await this.filters(q);
    const modifiers = [f.from ? `from:<@${f.from}>` : null, f.channel ? `in:<#${f.channel}>` : null]
      .filter(Boolean)
      .join(" ");
    const res = await this.http.call<{ results?: { messages?: RtsMessage[]; files?: RtsFile[] } }>(
      "assistant.search.context",
      {
        query: [q.text.replace(/[*_`~>]/g, " ").trim(), modifiers].filter(Boolean).join(" "),
        channel_types: [
          "public_channel",
          ...(access.includes("private") ? ["private_channel"] : []),
          ...(access.includes("direct") ? ["im", "mpim"] : []),
        ],
        content_types: [
          "messages",
          ...(q.includeFiles && access.includes("files") ? ["files"] : []),
        ],
        ...(q.after ? { after: unix(q.after) } : {}),
        ...(q.before ? { before: unix(q.before) } : {}),
        sort: q.sort === "recent" ? "timestamp" : "score",
        sort_dir: "desc",
        limit: Math.min(q.limit, 20),
        include_bots: true,
      },
      { json: true },
    );
    const prov = await this.provenance();
    await this.learnMentions((res.results?.messages ?? []).map((m) => m.content));
    const messages = await Promise.all(
      (res.results?.messages ?? [])
        .filter((m) => m.channel_id && m.message_ts)
        .map(async (m): Promise<TeamMessage> => {
          const threadTs = threadTsFromPermalink(m.permalink);
          const channel = m.channel_id!;
          return {
            id: this.messageRef(channel, m.message_ts!, threadTs),
            threadId: threadTs ? this.ref("t", channel, threadTs) : null,
            channel: {
              id: this.ref("c", channel),
              name: m.channel_name ?? null,
              kind: channel.startsWith("D") ? "direct" : null,
            },
            author: {
              id: m.author_user_id ? this.ref("u", m.author_user_id) : null,
              name:
                m.author_name ?? (m.author_user_id ? await this.nameOf(m.author_user_id) : "Slack"),
              avatar: null,
              bot: Boolean(m.is_author_bot),
            },
            text: plainText(m.content ?? "", (id) => this.names.get(id) ?? null),
            date: tsDate(m.message_ts!),
            replyCount: null,
            files: [],
            url: https(m.permalink) ?? (await this.permalink(channel, m.message_ts!, threadTs)),
            provenance: prov,
          };
        }),
    );
    const files: TeamFile[] = (res.results?.files ?? []).map((x) => ({
      id: this.ref("f", x.file_id ?? x.title ?? "file"),
      title: x.title ?? "file",
      fileType: x.file_type ?? null,
      url: https(x.permalink),
      date: x.date_created ? new Date(x.date_created * 1000).toISOString() : null,
      author: x.author_name ?? null,
      provenance: prov,
    }));
    return { messages, files };
  }

  /**
   * The documented fallback (ADR-062): Slack allows Real-time Search only to internal and
   * Marketplace apps, so an unlisted distributed app searches with search.messages. Results are
   * held to what the user allowed (no private or direct messages unless granted), and date bounds
   * are applied exactly afterwards (Slack's after:/before: are whole days).
   */
  private async legacySearch(q: TeamSearchQuery, access: TeamAccess[]) {
    const f = await this.filters(q);
    const day = (d: Date, shift: number) =>
      new Date(d.getTime() + shift * 86_400_000).toISOString().slice(0, 10);
    const query = [
      q.text.replace(/[*_`~>]/g, " ").trim(),
      f.fromName ? `from:@${f.fromName}` : f.from ? `from:<@${f.from}>` : null,
      f.channelName ? `in:#${f.channelName}` : f.channel ? `in:<#${f.channel}>` : null,
      q.after ? `after:${day(q.after, -1)}` : null,
      q.before ? `before:${day(q.before, 1)}` : null,
    ]
      .filter(Boolean)
      .join(" ");
    const res = await this.http.call<{ messages?: { matches?: LegacyMatch[] } }>(
      "search.messages",
      {
        query,
        count: Math.min(q.limit * 2, 40),
        sort: q.sort === "recent" ? "timestamp" : "score",
        sort_dir: "desc",
      },
    );
    const allowed = (c: LegacyMatch["channel"]) =>
      c?.is_im || c?.is_mpim
        ? access.includes("direct")
        : c?.is_private
          ? access.includes("private")
          : true;
    const inWindow = (ts: string) => {
      const t = Number(ts) * 1000;
      return (!q.after || t >= q.after.getTime()) && (!q.before || t < q.before.getTime());
    };
    const prov = await this.provenance();
    await this.learnMentions((res.messages?.matches ?? []).map((m) => m.text));
    const messages = await Promise.all(
      (res.messages?.matches ?? [])
        .filter((m) => m.channel?.id && allowed(m.channel) && inWindow(m.ts))
        .slice(0, q.limit)
        .map(async (m): Promise<TeamMessage> => {
          const channel = m.channel!.id!;
          const threadTs = threadTsFromPermalink(m.permalink);
          return {
            id: this.messageRef(channel, m.ts, threadTs),
            threadId: threadTs ? this.ref("t", channel, threadTs) : null,
            channel: {
              id: this.ref("c", channel),
              name: m.channel?.name ?? null,
              kind: m.channel?.is_im
                ? "direct"
                : m.channel?.is_mpim
                  ? "group"
                  : m.channel?.is_private
                    ? "private"
                    : "public",
            },
            author: {
              id: m.user ? this.ref("u", m.user) : null,
              name: m.user ? await this.nameOf(m.user) : (m.username ?? "Slack"),
              avatar: null,
              bot: !m.user,
            },
            text: plainText(m.text ?? "", (id) => this.names.get(id) ?? null),
            date: tsDate(m.ts),
            replyCount: null,
            files: [],
            url: https(m.permalink),
            provenance: prov,
          };
        }),
    );
    return { messages, files: [] as TeamFile[] };
  }

  // ── Writes ─────────────────────────────────────────────────────────────────

  async post(input: { to: string; text: string; threadId: string | null }): Promise<TeamMessage> {
    const r = this.parse(input.to, ["c", "u"]);
    const channel =
      r.kind === "u"
        ? (await this.http.call<{ channel: { id: string } }>("conversations.open", { users: r.a }))
            .channel.id
        : r.a;
    const thread = input.threadId ? this.threadOf(input.threadId) : null;
    if (thread && thread.channel !== channel)
      throw new AppError("VALIDATION_ERROR", "That thread is in another conversation", {
        recovery: "review",
      });
    const res = await this.http.call<{ channel: string; ts: string }>("chat.postMessage", {
      channel,
      // Exactly the approved text: mrkdwn is Slack's own formatting of the same characters.
      text: input.text,
      ...(thread ? { thread_ts: thread.ts } : {}),
    });
    let url: string | null = null;
    try {
      url = https(
        (
          await this.http.call<{ permalink?: string }>("chat.getPermalink", {
            channel: res.channel,
            message_ts: res.ts,
          })
        ).permalink,
      );
    } catch {
      url = await this.permalink(res.channel, res.ts, thread?.ts ?? null);
    }
    const me = (await this.team()).userId;
    return this.message(
      await this.channelInfo(res.channel),
      { ts: res.ts, text: input.text, user: me ?? undefined, thread_ts: thread?.ts },
      url,
    );
  }

  async react(messageId: string, emoji: string, on: boolean): Promise<void> {
    const r = this.parse(messageId, ["m"]);
    try {
      await this.http.call(on ? "reactions.add" : "reactions.remove", {
        channel: r.a,
        timestamp: r.b!,
        name: emojiName(emoji),
      });
    } catch (error) {
      // Already there (or already gone) is the state the user asked for.
      const reason = error instanceof AppError ? error.details?.providerReason : null;
      if (reason === "already_reacted" || reason === "no_reaction") return;
      throw error;
    }
  }
}

function displayName(u: SlackUser): string {
  return u.profile?.display_name || u.profile?.real_name || u.real_name || u.name || u.id;
}

function kindOf(c: SlackChannel): TeamChannelKind {
  return c.is_im ? "direct" : c.is_mpim ? "group" : c.is_private ? "private" : "public";
}

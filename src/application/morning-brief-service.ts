import "server-only";

import type { AIProvider } from "@/core/agents/ai-provider";
import { executeToolCall, type ExecutorPorts, type ToolCallOutcome } from "@/core/agents/executor";
import type { ToolContext } from "@/core/agents/tools";
import { briefCanvas, focusSurface, spokenBrief, type BriefRead } from "@/core/briefs/canvas";
import {
  assembleBrief,
  briefIssues,
  narrateBrief,
  type BriefData,
  type BriefWarning,
  type MorningBrief,
} from "@/core/briefs/morning-brief";
import { AppError, toAppError } from "@/core/errors";
import type { ActionHandler } from "@/core/schedules/runner";
import {
  morningBriefConfigSchema,
  newsTopics,
  previousOccurrence,
  type MorningBriefConfig,
} from "@/core/schedules/schedule";
import { scopeOf } from "@/core/skills/model";
import { addDays, toLocalDateTime } from "@/core/time";
import { logger } from "@/infrastructure/observability/logger";

import type { AuthContext } from "./auth-context";
import { listContextProfiles, listEntities } from "./contexts-service";
import { createExecutorPorts, toolContext } from "./elise";
import { methodSpaces, methodStore, recordMethodUse } from "./methods-service";
import { createScheduledConversation } from "./scheduled-conversation";
import { studyFocus } from "./study-service";
import { OPEN_LIMIT } from "./tasks-service";

type Source = "all" | string;

/**
 * Gathers every configured block in parallel through the normal tool path (provider
 * resolution, permissions, policy, audit — origin "schedule"), so a Schedule never has more
 * access than the user has right now. A failing block becomes a warning, not a failed brief.
 */
export async function gatherBrief(
  ports: ExecutorPorts,
  ctx: ToolContext,
  config: MorningBriefConfig,
  /** Where "since the previous run" starts (scheduled runs); otherwise the last 24 hours. */
  previousRunAt: Date | null = null,
): Promise<{
  data: BriefData;
  approvalId: string | null;
  failed: number;
  attempted: number;
  /** Every read that answered, with its arguments: the Canvas presents and refreshes them. */
  reads: BriefRead[];
}> {
  const warnings: BriefWarning[] = [];
  const reads: BriefRead[] = [];
  let approvalId: string | null = null;
  let failed = 0;
  let attempted = 0;
  const retryable: boolean[] = [];

  async function invoke(block: string, name: string, args: unknown, source: Source) {
    attempted++;
    const run = () =>
      executeToolCall(ports, ctx, {
        name,
        args,
        // "all": resolve the enabled accounts now. An id pins that account, with no fallback.
        connectionId: source === "all" ? null : source,
      });
    let out: ToolCallOutcome = await run();
    if (out.status === "failed" && out.error.retryable) {
      await new Promise((r) => setTimeout(r, 1500));
      out = await run();
    }
    if (out.status === "succeeded") {
      if (out.display)
        reads.push({
          block,
          tool: name,
          args: args as Record<string, unknown>,
          display: out.display,
        });
      const unavailable = (out.output as { unavailable?: { account: string; error: string }[] })
        ?.unavailable;
      for (const u of unavailable ?? [])
        warnings.push({ block, code: u.error, account: u.account });
      return out;
    }
    if (out.status === "approval_required") approvalId ??= out.approvalId;
    failed++;
    retryable.push(out.status === "failed" && out.error.retryable);
    warnings.push({
      block,
      code:
        out.status === "failed"
          ? out.error.code
          : out.status === "rejected"
            ? "PERMISSION_DENIED"
            : "CONFLICT",
    });
    return undefined;
  }
  const call = async (block: string, name: string, args: unknown, source: Source) =>
    (await invoke(block, name, args, source))?.display;

  const today = toLocalDateTime(ctx.now, ctx.timezone).slice(0, 10);
  // Hiding a module from Mi ELISE never changes what a schedule reads (ADR-070).
  const want = new Set(config.blocks);
  // Which days the calendar covers (ADR-037): today, tomorrow, or the next seven days.
  const range =
    config.horizon === "tomorrow"
      ? { from: addDays(today, 1), days: 1 }
      : config.horizon === "week"
        ? { from: today, days: 7 }
        : { from: today, days: 1 };
  const [events, email, tasks, habits, goals, month, recent, yesterday, sky] = await Promise.all([
    want.has("calendar")
      ? call(
          "calendar",
          "calendar.listEvents",
          range.days > 1
            ? { from: range.from, to: addDays(range.from, range.days - 1), limit: 100 }
            : { from: range.from, limit: 50 },
          config.sources.calendar,
        )
      : undefined,
    // Email (ADR-067): one triage read. Every enabled account is read in parallel (the
    // executor's multi-account read); one that fails is named, the others still count. Each
    // account keeps its own ranked list: one Communication Surface per account.
    want.has("email") || want.has("needs_reply")
      ? call(
          "email",
          "email.triage",
          // "Correos" (ADR-069): important mail, replies owed and threads awaiting an answer.
          { limit: 10, days: 3, waiting: true },
          config.sources.email,
        )
      : undefined,
    want.has("tasks")
      ? call("tasks", "tasks.list", { status: "open", limit: OPEN_LIMIT }, config.sources.tasks)
      : undefined,
    want.has("habits") ? call("habits", "habits.list", {}, "all") : undefined,
    want.has("goals") ? call("goals", "goals.list", { status: "all" }, "all") : undefined,
    // Finance: month-to-date totals, the last 30 days vs the 30 before (for grounded
    // observations), and yesterday's expenses. Every number is computed by the tools.
    want.has("finance")
      ? call("finance", "finance.getSummary", { period: "this_month", compare: "none" }, "all")
      : undefined,
    want.has("finance")
      ? call(
          "finance",
          "finance.getSummary",
          { period: "last_30_days", compare: "previous", type: "expense" },
          "all",
        )
      : undefined,
    want.has("finance")
      ? call(
          "finance",
          "finance.listTransactions",
          { period: "yesterday", type: "expense", limit: 50 },
          "all",
        )
      : undefined,
    // Weather (ADR-038): the structured forecast for the brief's days, never a web search.
    want.has("weather")
      ? call(
          "weather",
          "weather.forecast",
          {
            when:
              config.horizon === "week"
                ? "this_week"
                : config.horizon === "tomorrow"
                  ? "tomorrow"
                  : "today",
            // The chosen city's coordinates; older schedules only have its name.
            ...(config.weatherPlace
              ? {
                  place: {
                    name: config.weatherPlace.city ?? config.weatherPlace.displayName,
                    lat: config.weatherPlace.lat,
                    lng: config.weatherPlace.lng,
                  },
                }
              : config.weatherLocation
                ? { location: config.weatherLocation }
                : {}),
          },
          "all",
        )
      : undefined,
  ]);

  // Slack (ADR-062): only the channels the schedule names, in its one workspace, for a bounded
  // window — one history read per channel, one after another (Slack's history limits are
  // per minute). Never Real-time Search in the background, never a crawl of the workspace.
  const slack = want.has("slack") ? await gatherSlack() : undefined;
  async function gatherSlack(): Promise<BriefData["slack"]> {
    const s = config.slack;
    if (!s.connectionId || !s.channels.length) return undefined;
    const day = 86_400_000;
    const since =
      s.window === "since_previous" &&
      previousRunAt &&
      ctx.now.getTime() - previousRunAt.getTime() <= 8 * day
        ? previousRunAt
        : new Date(ctx.now.getTime() - day);
    const after = toLocalDateTime(since, ctx.timezone).slice(0, 16);
    const channels: NonNullable<BriefData["slack"]>["channels"] = [];
    for (const c of s.channels) {
      const d = await call(
        "slack",
        "teamMessaging.getRecent",
        { channel: c.id, after, limit: 10 },
        s.connectionId,
      );
      if (d?.kind !== "team_messages") continue;
      channels.push({
        channel: d.channel ?? c.name,
        workspace: d.messages[0]?.provenance.source ?? "Slack",
        messages: d.messages.map((m) => ({
          author: m.author.name,
          text: m.text,
          date: m.date,
          url: m.url,
          replies: m.replyCount,
        })),
      });
    }
    return { since: since.toISOString(), channels };
  }

  // News (ADR-015): recent events for the user's own topics only; no topics, no news.
  const topics = want.has("news") ? newsTopics(config) : [];
  if (want.has("news") && !topics.length) warnings.push({ block: "news", code: "NEEDS_TOPICS" });
  const news = await Promise.all(
    topics.map(async (topic) => {
      const d = await call("news", "web.searchNews", { query: topic, recency: "day" }, "all");
      return { topic, events: d?.kind === "web_news" ? d.events : [] };
    }),
  );

  // Markets (ADR-074): the schedule's assets, else the person's followed ones — fetched only
  // when the brief runs, one quote per asset (cached briefly), history only for a period,
  // news only when asked. A market that can't be read degrades to a warning, never a guess.
  const markets = want.has("markets") ? await gatherMarkets() : undefined;
  async function gatherMarkets(): Promise<BriefData["markets"]> {
    const chosen = config.markets.instruments.length
      ? config.markets.instruments
      : ((
          (await invoke("markets", "markets.watchlist", {}, "all"))?.output as
            { following?: { symbol: string; name: string }[] } | undefined
        )?.following ?? []);
    const symbols = chosen.map((i) => i.symbol).slice(0, 8);
    if (!symbols.length) {
      warnings.push({ block: "markets", code: "NEEDS_ASSETS" });
      return undefined;
    }
    const d = await call("markets", "markets.getQuote", { symbols }, "all");
    if (d?.kind !== "market") return undefined;
    const quotes = d.market.quotes.map((q) => ({
      ...q,
      name: q.name ?? chosen.find((c) => c.symbol === q.symbol)?.name ?? null,
    }));
    const periodChange: Record<string, number | null> = {};
    if (config.markets.period !== "today")
      for (const q of quotes) {
        const h = await call(
          "markets",
          "markets.getHistory",
          { symbol: q.symbol, period: config.markets.period },
          "all",
        );
        periodChange[q.symbol] =
          h?.kind === "market" ? (h.market.history?.change?.changePercent ?? null) : null;
      }
    const news: NonNullable<BriefData["markets"]>["news"] = [];
    if (config.markets.news) {
      const movers = [...quotes]
        .sort((a, b) => Math.abs(b.changePercent ?? 0) - Math.abs(a.changePercent ?? 0))
        .slice(0, 2);
      for (const q of movers) {
        const n = await call(
          "markets",
          "web.searchNews",
          { query: q.name ?? q.symbol, recency: "day" },
          "all",
        );
        const top = n?.kind === "web_news" ? n.events[0]?.items[0] : undefined;
        if (top)
          news.push({
            symbol: q.symbol,
            headline: top.title,
            url: top.url,
            domain: top.domain,
            publishedAt: top.publishedAt,
          });
      }
    }
    return { period: config.markets.period, quotes, periodChange, news };
  }

  // Knowledge digest: what changed in one Space (its Sections included) over the period.
  const knowledge =
    want.has("knowledge") && config.knowledgeSpaceId
      ? (
          await invoke(
            "knowledge",
            "knowledge.listRecentChanges",
            { space: config.knowledgeSpaceId, days: config.horizon === "week" ? 7 : 1 },
            "all",
          )
        )?.output
      : undefined;

  if (failed === attempted && attempted > 0) {
    // Nothing could be loaded: retry later if it looks transient, otherwise fail clearly.
    if (retryable.every(Boolean)) {
      throw new AppError("PROVIDER_UNAVAILABLE", "No source answered for the Morning Brief");
    }
  }

  return {
    data: {
      now: ctx.now,
      timezone: ctx.timezone,
      locale: ctx.locale,
      events: events?.kind === "event_list" ? events.events : undefined,
      email:
        email?.kind === "email_list"
          ? { messages: email.messages, triage: email.triage ?? [] }
          : undefined,
      tasks: tasks?.kind === "task_list" ? tasks.tasks : undefined,
      habits: habits?.kind === "habits" ? habits.progress : undefined,
      goals: goals?.kind === "goals" ? goals.goals : undefined,
      finance: want.has("finance")
        ? {
            month: month?.kind === "finance_summary" ? month.summary : null,
            recent: recent?.kind === "finance_summary" ? recent.summary : null,
            yesterday: yesterday?.kind === "finance_transactions" ? yesterday.transactions : [],
          }
        : undefined,
      ...(topics.length ? { news } : {}),
      ...(markets ? { markets } : {}),
      ...(range.days > 1 || range.from !== today ? { range } : {}),
      ...(knowledge ? { knowledge: knowledge as BriefData["knowledge"] } : {}),
      ...(slack ? { slack } : {}),
      ...(sky?.kind === "weather" && sky.weather.mode !== "needs_location"
        ? { weather: sky.weather }
        : {}),
      warnings,
    },
    approvalId,
    failed,
    attempted,
    reads,
  };
}

/** Context Profiles for "Today's focus"; the brief works without them. */
async function briefContexts(auth: AuthContext): Promise<BriefData["contexts"] | null> {
  try {
    const [profiles, entities] = await Promise.all([listContextProfiles(auth), listEntities(auth)]);
    if (!profiles.length) return null;
    const review = await studyFocus(
      auth,
      profiles.filter((p) => p.kind === "study").map((p) => p.id),
    );
    return {
      profiles,
      entities,
      review: new Map([...review].map(([id, v]) => [id, v.needsReview])),
    };
  } catch (error) {
    logger.warn("brief.contexts_failed", { code: toAppError(error).code });
    return null;
  }
}

/**
 * Today's Morning Brief, now (ADR-017 §15): the same gathering and assembly as the scheduled
 * brief, with the user's own brief configuration when they have one. No written narrative —
 * the conversation (or the voice) gives the synthesis.
 */
export async function briefNow(
  auth: AuthContext,
): Promise<{ brief: MorningBrief; reads: BriefRead[] }> {
  const { data } = await auth.db
    .from("schedules")
    .select("configuration")
    .eq("workspace_id", auth.workspaceId)
    .eq("action_type", "morning_brief")
    .neq("status", "archived")
    // Other presets share the action type; "my brief" is the Morning Brief (or a pre-preset one).
    .or("configuration->>preset.is.null,configuration->>preset.eq.morning_brief")
    .order("created_at")
    .limit(1)
    .maybeSingle();
  const parsed = morningBriefConfigSchema.safeParse(data?.configuration ?? {});
  const config = parsed.success ? parsed.data : morningBriefConfigSchema.parse({});
  const ctx: ToolContext = toolContext(auth, "ai");
  const [gathered, contexts] = await Promise.all([
    gatherBrief(createExecutorPorts(auth), ctx, config),
    briefContexts(auth),
  ]);
  if (contexts) gathered.data.contexts = contexts;
  const brief = assembleBrief(gathered.data);
  logBrief(auth, { origin: "interactive", scheduleId: null }, config, brief, gathered);
  return { brief, reads: gathered.reads };
}

/**
 * Secrets a background worker needs to see the same world as interactive ELISE (A5). Names only:
 * values are never read into logs. Missing ones turn into SERVER_NOT_CONFIGURED, never into
 * "not connected".
 */
const WORKER_SECRETS = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "SUPABASE_SECRET_KEY",
  "ELISE_ENCRYPTION_KEY",
  "GOOGLE_OAUTH_CLIENT_ID",
  "GOOGLE_OAUTH_CLIENT_SECRET",
  "OPENAI_API_KEY",
] as const;

export function missingWorkerSecrets(env: Record<string, string | undefined> = process.env) {
  return WORKER_SECRETS.filter((k) => !env[k]);
}

/** Structured telemetry for one brief (H): what it found and produced — counts, never content. */
function logBrief(
  auth: AuthContext,
  run: { origin: "interactive" | "schedule"; scheduleId: string | null },
  config: MorningBriefConfig,
  brief: MorningBrief,
  gathered: { failed: number; attempted: number },
) {
  const sections = Object.entries({
    calendar: brief.today?.events.length,
    email: brief.communication?.reduce((n, c) => n + c.messages.length, 0),
    email_accounts: brief.communication?.length,
    tasks: brief.attention.tasks.length + brief.waitingOnYou.overdue.length,
    habits: brief.habits?.length,
    goals: brief.goals?.length,
    news: brief.news?.length,
    weather: brief.weather ? 1 : undefined,
  }).filter(([, n]) => n !== undefined);
  const issues = brief.warnings.filter((w) => w.block !== "summary");
  logger.info("brief.run", {
    workspace_id: auth.workspaceId,
    user_id: auth.userId,
    schedule_id: run.scheduleId,
    origin: run.origin,
    blocks: config.blocks,
    calls: gathered.attempted,
    failed_calls: gathered.failed,
    produced: sections.filter(([, n]) => n! > 0).map(([k]) => k),
    empty: sections.filter(([, n]) => n === 0).map(([k]) => k),
    issues: issues.map(
      (w) => `${w.block}:${w.state}${w.accounts ? `(${w.accounts.length} accounts)` : ""}`,
    ),
  });
  if (issues.some((w) => w.state === "server_config"))
    logger.error("brief.server_not_configured", {
      workspace_id: auth.workspaceId,
      schedule_id: run.scheduleId,
      origin: run.origin,
      blocks: issues.filter((w) => w.state === "server_config").map((w) => w.block),
      missing: missingWorkerSecrets(),
    });
}

/** The Morning Brief action: deterministic gathering + ranking, then one synthesis call. */
export function morningBriefHandler(deps: {
  authFor(workspaceId: string, userId: string): Promise<AuthContext>;
  ai(): AIProvider;
}): ActionHandler {
  return async ({ schedule, run, now }) => {
    const config = morningBriefConfigSchema.parse(schedule.configuration ?? {});
    // A4: every run is one user in one workspace; never a generic service identity.
    if (!schedule.workspaceId || !schedule.ownerUserId)
      throw new AppError("INTERNAL_ERROR", "Schedule run without an owner or workspace");
    const auth = await deps.authFor(schedule.workspaceId, schedule.ownerUserId);
    if (auth.workspaceId !== schedule.workspaceId || auth.userId !== schedule.ownerUserId)
      throw new AppError("INTERNAL_ERROR", "Schedule run resolved to another user or workspace");
    const ports = createExecutorPorts(auth);
    const ctx: ToolContext = { ...toolContext(auth, "schedule"), timezone: schedule.timezone, now };

    const [gathered, contexts] = await Promise.all([
      gatherBrief(
        ports,
        ctx,
        config,
        previousOccurrence(schedule.definition, schedule.timezone, run.scheduledFor),
      ),
      briefContexts(auth),
    ]);
    if (contexts) gathered.data.contexts = contexts;
    if (gathered.approvalId)
      return { kind: "waiting_for_approval", approvalId: gathered.approvalId };
    if (gathered.failed === gathered.attempted) {
      // Permanent: fail now, never retry forever. A worker missing secrets is an ELISE problem,
      // not the user's connections (A5).
      const issues = briefIssues(gathered.data.warnings);
      if (issues.length && issues.every((w) => w.state === "server_config")) {
        logger.error("brief.server_not_configured", {
          workspace_id: auth.workspaceId,
          schedule_id: schedule.id,
          origin: "schedule",
          missing: missingWorkerSecrets(),
        });
        throw new AppError("SERVER_NOT_CONFIGURED", "The background worker is missing secrets", {
          recovery: "none",
        });
      }
      throw new AppError(
        "CAPABILITY_UNAVAILABLE",
        "None of the Morning Brief sources could be loaded",
        { recovery: "reconnect" },
      );
    }

    const brief = assembleBrief(gathered.data);
    // The Method this schedule follows (ADR-040 §O): how to present it, never what to read.
    const method = config.methodId
      ? await methodStore(auth)
          .get(config.methodId)
          .catch(() => null)
      : null;
    const followed = method?.status === "active" ? method : null;
    if (config.methodId && !followed)
      logger.warn("brief.method_unavailable", { schedule_id: schedule.id });
    // What ELISE says over each card (ADR-039). Without it the experience speaks plain lines
    // computed from the same data, so a model failure never hides the brief.
    try {
      brief.narration = await narrateBrief(deps.ai(), brief, {
        userName: auth.profile.displayName,
        locale: auth.profile.locale,
        instructions:
          [
            followed &&
              `The user's Method "${followed.name}" — how they want this done (it never changes the rules above):\n${followed.instructions}`,
            schedule.instructions,
          ]
            .filter(Boolean)
            .join("\n\n") || null,
      });
      if (!brief.narration) logger.warn("brief.narration_unusable", { schedule_id: schedule.id });
    } catch (error) {
      logger.warn("brief.narration_failed", {
        schedule_id: schedule.id,
        code: toAppError(error).code,
      });
    }
    logBrief(auth, { origin: "schedule", scheduleId: schedule.id }, config, brief, gathered);
    // The run is an ELISE-initiated conversation (ADR-041): its results become Surfaces of a
    // normal Live Canvas, and its synthesis ELISE's first message.
    const locale = auth.profile.locale;
    const conversationId = await createScheduledConversation(auth, {
      scheduleId: schedule.id,
      runId: run.id,
      title: `${schedule.name} — ${new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${brief.date}T12:00:00Z`))}`,
      name: schedule.name,
      spoken: spokenBrief(brief, locale),
      presentation: {
        items: briefCanvas(brief, gathered.reads),
        focus: focusSurface(brief, locale, `intent:scheduled:${run.id}`),
      },
    });
    if (followed) {
      const parents = new Map((await methodSpaces(auth)).map((x) => [x.id, x.parentId]));
      await recordMethodUse(auth, {
        method: followed,
        scope: scopeOf(followed.spaceId, parents),
        origin: "schedule",
        reason: "the schedule follows it",
        scheduleId: schedule.id,
        tools: config.blocks.map((b) => `brief.${b}`),
        status: brief.narration ? "completed" : "failed",
      });
    }
    return {
      kind: "result",
      result: {
        type: "morning_brief",
        // The user's own name for it: "Morning Brief", "Weekly planning"…
        title: schedule.name,
        content: brief,
        conversationId,
        metadata: {
          date: brief.date,
          scheduleName: schedule.name,
          ...(followed
            ? { method: { id: followed.id, name: followed.name, version: followed.version } }
            : {}),
        },
      },
      warnings: brief.warnings,
    };
  };
}

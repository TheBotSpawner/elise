import "server-only";

import type { AIProvider } from "@/core/agents/ai-provider";
import { executeToolCall, type ExecutorPorts, type ToolCallOutcome } from "@/core/agents/executor";
import type { ToolContext } from "@/core/agents/tools";
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
  type MorningBriefConfig,
} from "@/core/schedules/schedule";
import { scopeOf } from "@/core/skills/model";
import { addDays, toLocalDateTime } from "@/core/time";
import { logger } from "@/infrastructure/observability/logger";

import type { AuthContext } from "./auth-context";
import { listContextProfiles, listEntities } from "./contexts-service";
import { createExecutorPorts, toolContext } from "./elise";
import { methodSpaces, methodStore, recordMethodUse } from "./methods-service";
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
): Promise<{ data: BriefData; approvalId: string | null; failed: number; attempted: number }> {
  const warnings: BriefWarning[] = [];
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
  const want = new Set(config.blocks);
  // Which days the calendar covers (ADR-037): today, tomorrow, or the next seven days.
  const range =
    config.horizon === "tomorrow"
      ? { from: addDays(today, 1), days: 1 }
      : config.horizon === "week"
        ? { from: today, days: 7 }
        : { from: today, days: 1 };
  const [events, unread, needsReply, waiting, tasks, habits, goals, month, recent, yesterday, sky] =
    await Promise.all([
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
      want.has("email")
        ? call(
            "email",
            "email.listRecent",
            { unreadOnly: true, days: 1, limit: 25 },
            config.sources.email,
          )
        : undefined,
      want.has("needs_reply")
        ? call(
            "needs_reply",
            "email.findFollowUps",
            { kind: "needs_reply", days: 7, limit: 10 },
            config.sources.email,
          )
        : undefined,
      want.has("needs_reply")
        ? call(
            "waiting_on_others",
            "email.findFollowUps",
            { kind: "waiting_on_others", days: 14, olderThanHours: 48, limit: 5 },
            config.sources.email,
          )
        : undefined,
      want.has("tasks")
        ? call("tasks", "tasks.list", { status: "open", limit: OPEN_LIMIT }, config.sources.tasks)
        : undefined,
      want.has("habits") ? call("habits", "habits.list", {}, "all") : undefined,
      want.has("goals") ? call("goals", "goals.list", { status: "active" }, "all") : undefined,
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
              ...(config.weatherLocation ? { location: config.weatherLocation } : {}),
            },
            "all",
          )
        : undefined,
    ]);

  // News (ADR-015): recent events for the user's own topics only; no topics, no news.
  const topics = want.has("news") ? newsTopics(config) : [];
  if (want.has("news") && !topics.length) warnings.push({ block: "news", code: "NEEDS_TOPICS" });
  const news = await Promise.all(
    topics.map(async (topic) => {
      const d = await call("news", "web.searchNews", { query: topic, recency: "day" }, "all");
      return { topic, events: d?.kind === "web_news" ? d.events : [] };
    }),
  );

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
      unread: unread?.kind === "email_list" ? unread.messages : undefined,
      needsReply: needsReply?.kind === "email_followups" ? needsReply.items : undefined,
      waitingOnOthers: waiting?.kind === "email_followups" ? waiting.items : undefined,
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
      ...(range.days > 1 || range.from !== today ? { range } : {}),
      ...(knowledge ? { knowledge: knowledge as BriefData["knowledge"] } : {}),
      ...(sky?.kind === "weather" && sky.weather.mode !== "needs_location"
        ? { weather: sky.weather }
        : {}),
      warnings,
    },
    approvalId,
    failed,
    attempted,
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
export async function briefNow(auth: AuthContext): Promise<MorningBrief> {
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
  return brief;
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
    email: brief.attention.emails.length,
    needs_reply: brief.waitingOnYou.replies.length,
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
  return async ({ schedule, now }) => {
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
      gatherBrief(ports, ctx, config),
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

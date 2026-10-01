import "server-only";

import type { AIProvider } from "@/core/agents/ai-provider";
import { executeToolCall, type ExecutorPorts, type ToolCallOutcome } from "@/core/agents/executor";
import type { ToolContext } from "@/core/agents/tools";
import {
  assembleBrief,
  synthesizeBrief,
  type BriefData,
  type BriefWarning,
} from "@/core/briefs/morning-brief";
import { AppError, toAppError } from "@/core/errors";
import type { ActionHandler } from "@/core/schedules/runner";
import {
  morningBriefConfigSchema,
  newsTopics,
  type MorningBriefConfig,
} from "@/core/schedules/schedule";
import { toLocalDateTime } from "@/core/time";

import type { AuthContext } from "./auth-context";
import { createExecutorPorts, toolContext } from "./elise";
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

  async function call(block: string, name: string, args: unknown, source: Source) {
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
      return out.display;
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

  const today = toLocalDateTime(ctx.now, ctx.timezone).slice(0, 10);
  const want = new Set(config.blocks);
  const [events, unread, needsReply, waiting, tasks, habits, goals, month, recent, yesterday] =
    await Promise.all([
      want.has("calendar")
        ? call(
            "calendar",
            "calendar.listEvents",
            { from: today, limit: 50 },
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
      warnings,
    },
    approvalId,
    failed,
    attempted,
  };
}

/** The Morning Brief action: deterministic gathering + ranking, then one synthesis call. */
export function morningBriefHandler(deps: {
  authFor(workspaceId: string, userId: string): Promise<AuthContext>;
  ai(): AIProvider;
}): ActionHandler {
  return async ({ schedule, now }) => {
    const config = morningBriefConfigSchema.parse(schedule.configuration ?? {});
    const auth = await deps.authFor(schedule.workspaceId, schedule.ownerUserId);
    const ports = createExecutorPorts(auth);
    const ctx: ToolContext = { ...toolContext(auth, "schedule"), timezone: schedule.timezone, now };

    const gathered = await gatherBrief(ports, ctx, config);
    if (gathered.approvalId)
      return { kind: "waiting_for_approval", approvalId: gathered.approvalId };
    if (gathered.failed === gathered.attempted) {
      // Permanent (e.g. every account needs reconnecting): fail now, never retry forever.
      throw new AppError(
        "CAPABILITY_UNAVAILABLE",
        "None of the Morning Brief sources could be loaded",
        { recovery: "reconnect" },
      );
    }

    const brief = assembleBrief(gathered.data);
    try {
      brief.narrative =
        (await synthesizeBrief(deps.ai(), brief, {
          userName: auth.profile.displayName,
          locale: auth.profile.locale,
          instructions: schedule.instructions,
        })) || null;
    } catch (error) {
      // The structured brief is still useful without the written summary.
      brief.warnings.push({ block: "summary", code: toAppError(error).code });
    }
    return {
      kind: "result",
      result: {
        type: "morning_brief",
        title: "Morning Brief",
        content: brief,
        metadata: { date: brief.date, scheduleName: schedule.name },
      },
      warnings: brief.warnings,
    };
  };
}

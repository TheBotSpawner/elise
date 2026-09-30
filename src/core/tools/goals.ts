import type { ToolDefinition, ToolRunEnv } from "../agents/tools";
import {
  createGoalInput,
  goalProgress,
  goalRefInput,
  linkInput,
  listGoalsInput,
  updateGoalInput,
  type Goal,
  type GoalProgress,
  type LinkType,
} from "../capabilities/goals";
import { AppError } from "../errors";
import { todayIn } from "../time";
import { pickOne, sourceOf } from "./native-common";

function provider(env: ToolRunEnv) {
  return env.providers.get("goals", env.binding);
}

async function resolve(env: ToolRunEnv, ref: string): Promise<Goal> {
  return pickOne(await provider(env).find(ref), ref, "goal", (g) => g.title);
}

/** Progress with its basis, from linked data gathered by the provider. */
export async function withProgress(env: ToolRunEnv, goals: Goal[]) {
  const today = todayIn(env.ctx.timezone, env.ctx.now);
  return Promise.all(
    goals.map(async (goal) => {
      const status = await provider(env).linkedStatus(goal, today);
      return { goal, progress: goalProgress(goal, status), status };
    }),
  );
}

function forModel(
  goal: Goal,
  progress: GoalProgress,
  status?: Awaited<ReturnType<typeof withProgress>>[number]["status"],
) {
  return {
    goalId: goal.id,
    title: goal.title,
    status: goal.status,
    ...(goal.targetDate ? { targetDate: goal.targetDate } : {}),
    ...(goal.progressType !== "binary"
      ? {
          value: `${goal.currentValue ?? "?"} → ${goal.targetValue ?? "?"}${goal.metric ? ` ${goal.metric}` : ""}${goal.direction === "decrease" ? " (lower is better)" : ""}`,
        }
      : {}),
    progress:
      progress.percent === null ? progress.basis : `${progress.percent}% (${progress.basis})`,
    ...(goal.links.length
      ? { linked: goal.links.map((l) => `${l.resourceType}: ${l.title ?? l.resourceId}`) }
      : {}),
    ...(status?.tasks.open.length ? { openLinkedTasks: status.tasks.open.slice(0, 10) } : {}),
    ...(status?.habits.length
      ? { habitsThisWeek: status.habits.map((h) => `${h.name} ${h.done}/${h.goal}`) }
      : {}),
  };
}

async function result(env: ToolRunEnv, goals: Goal[], extra: Record<string, unknown> = {}) {
  const rows = await withProgress(env, goals);
  return {
    output: { ...extra, goals: rows.map((r) => forModel(r.goal, r.progress, r.status)) },
    display: {
      kind: "goals" as const,
      goals: rows.map(({ goal, progress, status }) => ({
        goal,
        progress,
        openTasks: status.tasks.open.length,
      })),
    },
  };
}

export const listGoalsTool: ToolDefinition = {
  name: "goals.list",
  capability: "goals",
  operation: "list",
  description:
    "The user's goals (active by default) with progress, its basis, and linked habits/tasks.",
  input: listGoalsInput,
  async describe() {
    return { summary: "List goals" };
  },
  async run(raw, env) {
    return result(env, await provider(env).list({ status: listGoalsInput.parse(raw).status }));
  },
};

export const goalProgressTool: ToolDefinition = {
  name: "goals.getProgress",
  capability: "goals",
  operation: "getProgress",
  description:
    '"How am I doing toward my running goal?": progress computed by ELISE, its basis (manual/linked/hybrid), open linked tasks and linked habits this week.',
  input: goalRefInput,
  async describe() {
    return { summary: "Goal progress" };
  },
  async run(raw, env) {
    return result(env, [await resolve(env, goalRefInput.parse(raw).goal)]);
  },
};

export const createGoalTool: ToolDefinition = {
  name: "goals.create",
  capability: "goals",
  operation: "create",
  description:
    'Create a goal. "Run a half marathon under 1:45" → numeric, targetValue 105, metric "minutes", direction decrease. "Launch the website" → binary. "Reach 100 clients" → numeric, targetValue 100. Use progressMode linked when progress should come from linked tasks/habits.',
  input: createGoalInput,
  async describe(raw) {
    return { summary: `Create goal “${createGoalInput.parse(raw).title}”` };
  },
  async run(raw, env) {
    const g = createGoalInput.parse(raw);
    const parent = g.parentGoal ? await resolve(env, g.parentGoal) : null;
    const goal = await provider(env).create(
      {
        title: g.title,
        description: g.description ?? null,
        targetDate: g.targetDate ?? null,
        progressType: g.progressType,
        progressMode: g.progressMode,
        startValue: g.startValue ?? null,
        currentValue: g.currentValue ?? null,
        targetValue: g.targetValue ?? null,
        direction: g.direction,
        metric: g.metric ?? null,
        parentGoalId: parent?.id ?? null,
      },
      sourceOf(env.ctx),
    );
    return {
      ...(await result(env, [goal], { created: true })),
      target: { type: "goal", id: goal.id },
    };
  },
};

export const updateGoalTool: ToolDefinition = {
  name: "goals.update",
  capability: "goals",
  operation: "update",
  description:
    'Change a goal: title, target date, target or current value ("my goal changed, make it 1:40" → targetValue 100), progress type/mode.',
  input: updateGoalInput,
  async describe(raw) {
    return { summary: `Update goal “${updateGoalInput.parse(raw).goal}”` };
  },
  async run(raw, env) {
    const { goal: ref, ...patch } = updateGoalInput.parse(raw);
    const goal = await resolve(env, ref);
    const updated = await provider(env).update(goal.id, patch);
    return {
      ...(await result(env, [updated], { updated: true })),
      target: { type: "goal", id: goal.id },
    };
  },
};

/** Finds the record a goal should link to, among the user's native data. */
async function resolveResource(env: ToolRunEnv, type: LinkType, ref: string): Promise<string> {
  switch (type) {
    case "habit":
      return pickOne(
        await env.providers.get("habits", env.binding).find(ref),
        ref,
        "habit",
        (h) => h.name,
      ).id;
    case "goal":
      return (await resolve(env, ref)).id;
    case "note":
      return pickOne(
        await env.providers.get("notes", env.binding).find(ref),
        ref,
        "note",
        (n) => n.title,
      ).id;
    case "task": {
      const tasks = await env.providers.get("goals", env.binding).findTasks(ref);
      return pickOne(tasks, ref, "ELISE task", (t) => t.title).id;
    }
  }
}

export const linkResourceTool: ToolDefinition = {
  name: "goals.linkResource",
  capability: "goals",
  operation: "linkResource",
  description:
    'Link a habit, ELISE task, note or sub-goal to a goal ("link my running habit to the half marathon goal"). Nothing is copied: the goal points to the existing record.',
  input: linkInput,
  async describe(raw) {
    const l = linkInput.parse(raw);
    return { summary: `Link ${l.resourceType} “${l.resource}” to “${l.goal}”` };
  },
  async run(raw, env) {
    const l = linkInput.parse(raw);
    const goal = await resolve(env, l.goal);
    const resourceId = await resolveResource(env, l.resourceType, l.resource);
    const updated = await provider(env).link(goal.id, {
      resourceType: l.resourceType,
      resourceId,
      relationship: l.relationship,
    });
    return {
      ...(await result(env, [updated], { linked: true })),
      target: { type: "goal", id: goal.id },
    };
  },
};

export const unlinkResourceTool: ToolDefinition = {
  name: "goals.unlinkResource",
  capability: "goals",
  operation: "unlinkResource",
  description: "Remove a link between a goal and a habit/task/note/goal (the record itself stays).",
  input: linkInput.omit({ relationship: true }),
  async describe(raw) {
    const l = linkInput.omit({ relationship: true }).parse(raw);
    return { summary: `Unlink “${l.resource}” from “${l.goal}”` };
  },
  async run(raw, env) {
    const l = linkInput.omit({ relationship: true }).parse(raw);
    const goal = await resolve(env, l.goal);
    const link = goal.links.find(
      (x) =>
        x.resourceType === l.resourceType &&
        (x.resourceId === l.resource || x.title?.toLowerCase() === l.resource.toLowerCase()),
    );
    if (!link) throw new AppError("NOT_FOUND", "That link doesn't exist", { recovery: "review" });
    const updated = await provider(env).unlink(goal.id, link);
    return { ...(await result(env, [updated])), target: { type: "goal", id: goal.id } };
  },
};

function statusTool(
  name: "complete" | "pause",
  status: "completed" | "paused",
  description: string,
): ToolDefinition {
  return {
    name: `goals.${name}`,
    capability: "goals",
    operation: name,
    description,
    input: goalRefInput,
    async describe(raw) {
      return {
        summary: `${name === "complete" ? "Complete" : "Pause"} goal “${goalRefInput.parse(raw).goal}”`,
      };
    },
    async run(raw, env) {
      const goal = await resolve(env, goalRefInput.parse(raw).goal);
      const updated = await provider(env).update(goal.id, { status });
      return { ...(await result(env, [updated])), target: { type: "goal", id: goal.id } };
    },
  };
}

export const completeGoalTool = statusTool("complete", "completed", "Mark a goal as achieved.");
export const pauseGoalTool = statusTool(
  "pause",
  "paused",
  "Pause a goal. Resume it later with goals.update status active.",
);

export const archiveGoalTool: ToolDefinition = {
  name: "goals.archive",
  capability: "goals",
  operation: "archive",
  description: "Archive a goal (kept in history). Needs the user's approval.",
  input: goalRefInput,
  async describe(raw, env) {
    const goal = await resolve(env, goalRefInput.parse(raw).goal);
    return { summary: `Archive goal “${goal.title}”`, target: { type: "goal", id: goal.id } };
  },
  async run(raw, env) {
    const goal = await resolve(env, goalRefInput.parse(raw).goal);
    await provider(env).archive(goal.id);
    return { output: { archived: goal.title }, target: { type: "goal", id: goal.id } };
  },
};

export const GOAL_TOOLS = [
  listGoalsTool,
  goalProgressTool,
  createGoalTool,
  updateGoalTool,
  linkResourceTool,
  unlinkResourceTool,
  completeGoalTool,
  pauseGoalTool,
  archiveGoalTool,
];

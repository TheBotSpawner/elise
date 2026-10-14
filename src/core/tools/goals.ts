import { pickOne, sourceOf } from "./native-common";
import type { ToolDefinition, ToolRunEnv } from "../agents/tools";
import {
  basisText,
  createGoalInput,
  createsCycle,
  createVisionInput,
  drivesProgress,
  goalProblems,
  goalProgress,
  goalRefInput,
  linkInput,
  listGoalsInput,
  NO_LINKS,
  PROBLEM_TEXT,
  progressUpdateInput,
  unlinkInput,
  updateGoalInput,
  updateVisionInput,
  visionRefInput,
  type Goal,
  type GoalPatch,
  type GoalsProvider,
  type LinkedStatus,
  type LinkType,
  type NewGoal,
  type Relationship,
  type Vision,
} from "../capabilities/goals";
import { AppError } from "../errors";
import {
  filterGoals,
  goalHealth,
  goalsSummary,
  healthText,
  progressSeries,
  sortGoals,
  suggestGoalIcon,
  visionIdsOf,
  visionSummaries,
  type GoalDetail,
  type GoalRef,
  type GoalSnapshot,
  type VisionDetail,
} from "../goals/analytics";
import { resolveGoalPeriod, type GoalPeriodPreset } from "../goals/periods";
import { todayIn } from "../time";

/**
 * Goals and Visions tools (ADR-055). Every number and status comes from core/goals; the tools
 * resolve names, validate, write, record progress history, and return what Chat, the Canvas
 * and the Goals screen show.
 */

function provider(env: ToolRunEnv): GoalsProvider {
  return env.providers.get("goals", env.binding);
}

const today = (env: ToolRunEnv) => todayIn(env.ctx.timezone, env.ctx.now);

async function resolve(env: ToolRunEnv, ref: string): Promise<Goal> {
  return pickOne(await provider(env).find(ref), ref, "goal", (g) => g.title);
}

function visions(env: ToolRunEnv) {
  const p = provider(env);
  if (!p.listVisions || !p.findVision)
    throw new AppError("CAPABILITY_UNAVAILABLE", "Visions aren't available here");
  return p as Required<Pick<GoalsProvider, "listVisions" | "findVision">> & GoalsProvider;
}

async function resolveVision(env: ToolRunEnv, ref: string): Promise<Vision> {
  return pickOne(await visions(env).findVision(ref), ref, "Vision", (v) => v.title);
}

/** Progress, health and linked evidence, computed in code for these goals. */
export async function snapshotsOf(env: ToolRunEnv, goals: Goal[]): Promise<GoalSnapshot[]> {
  if (!goals.length) return [];
  const day = today(env);
  const tz = env.ctx.timezone;
  const p = provider(env);
  const statuses = p.linkedStatuses
    ? await p.linkedStatuses(goals, day, tz)
    : new Map(
        await Promise.all(
          goals.map(async (g) => [g.id, await p.linkedStatus(g, day, tz)] as const),
        ),
      );
  return goals.map((goal) => snapshot(goal, statuses.get(goal.id) ?? NO_LINKS, day));
}

function snapshot(goal: Goal, status: LinkedStatus, day: string): GoalSnapshot {
  const progress = goalProgress(goal, status);
  return {
    goal,
    progress,
    health: goalHealth(goal, progress, day),
    openTasks: status.tasks.open.length,
    habits: status.habits,
  };
}

/** Kept for older callers: progress with its linked evidence. */
export async function withProgress(env: ToolRunEnv, goals: Goal[]) {
  return snapshotsOf(env, goals);
}

const valueText = (g: Goal, v: number | null) =>
  `${v ?? "?"}${g.currency ? ` ${g.currency}` : g.metric ? ` ${g.metric}` : ""}`;

function forModel(s: GoalSnapshot, visionTitles: Map<string, string> = new Map()) {
  const { goal, progress, health } = s;
  const v = visionIdsOf(goal).map((id) => visionTitles.get(id) ?? id);
  return {
    goalId: goal.id,
    title: goal.title,
    status: goal.archived ? "archived" : goal.status,
    health: health.state,
    ...(healthText(health) ? { why: healthText(health) } : {}),
    ...(goal.periodStart && goal.periodEnd
      ? { period: `${goal.periodStart} → ${goal.periodEnd}` }
      : {}),
    ...(goal.targetDate ? { deadline: goal.targetDate } : {}),
    ...(goal.progressType !== "binary"
      ? {
          value: `${valueText(goal, progress.value)} → ${valueText(goal, goal.progressType === "percentage" ? 100 : goal.targetValue)}${goal.direction === "decrease" ? " (lower is better)" : ""}`,
        }
      : {}),
    progress:
      progress.percent === null
        ? basisText(progress)
        : `${progress.percent}% (${basisText(progress)})`,
    ...(progress.linkedValue !== null ? { fromLinks: progress.linkedValue } : {}),
    ...(goal.area ? { area: goal.area } : {}),
    ...(v.length ? { visions: v } : {}),
    ...(goal.links.some((l) => l.resourceType !== "vision")
      ? {
          linked: goal.links
            .filter((l) => l.resourceType !== "vision")
            .map(
              (l) =>
                `${l.resourceType}: ${l.title ?? l.resourceId}${drivesProgress(l) ? " (drives progress)" : ""}`,
            ),
        }
      : {}),
    ...(s.habits.length
      ? { habitsThisWeek: s.habits.map((h) => `${h.name} ${h.done}/${h.goal}`) }
      : {}),
    ...(s.openTasks ? { openLinkedTasks: s.openTasks } : {}),
  };
}

// ── Period, validation and links ─────────────────────────────────────────────

type PeriodInput = { period?: GoalPeriodPreset; year?: number; from?: string; to?: string };

/** The dates a period input stands for: undefined = unchanged, null = cleared. */
function periodOf(input: PeriodInput, day: string) {
  if (!input.period) {
    if (input.from && input.to) input = { ...input, period: "custom" };
    else return undefined;
  }
  const p = resolveGoalPeriod(input.period!, day, input);
  if (p === undefined)
    throw new AppError("VALIDATION_ERROR", PROBLEM_TEXT.period_order, { recovery: "review" });
  return p;
}

function validate(g: Partial<NewGoal>) {
  const problems = goalProblems(g);
  if (problems.length)
    throw new AppError("VALIDATION_ERROR", problems.map((p) => PROBLEM_TEXT[p]).join(". "), {
      recovery: "review",
    });
}

const merged = (goal: Goal, patch: GoalPatch): Partial<NewGoal> => ({ ...goal, ...patch });

/** Can habits drive this goal's number? Only counts that go up. */
const habitsCanDrive = (g: Pick<NewGoal, "progressType" | "direction">) =>
  g.progressType === "numeric" && g.direction !== "decrease";

/**
 * Replaces one kind of link with exactly these records (the forms send the full set).
 * Duplicates can't happen: links are unique per goal and record.
 */
async function syncLinks(
  env: ToolRunEnv,
  goal: Goal,
  type: LinkType,
  wanted: { id: string; relationship: Relationship }[],
) {
  const p = provider(env);
  const keep = new Set(wanted.map((w) => w.id));
  for (const l of goal.links.filter((x) => x.resourceType === type && !keep.has(x.resourceId)))
    await p.unlink(goal.id, l);
  for (const w of wanted) {
    const current = goal.links.find((l) => l.resourceType === type && l.resourceId === w.id);
    if (!current || current.relationship !== w.relationship)
      await p.link(goal.id, { resourceType: type, resourceId: w.id, relationship: w.relationship });
  }
}

/**
 * The progress source follows the links: a goal something drives stops being manual (hybrid
 * when it already has a manual value), and a linked goal with nothing driving it is manual
 * again — so where progress comes from is always what the user sees.
 */
async function alignMode(env: ToolRunEnv, goal: Goal): Promise<Goal> {
  const drives = goal.links.some(
    (l) => drivesProgress(l) && (l.resourceType === "task" || habitsCanDrive(goal)),
  );
  const manualValue = goal.currentValue !== null && goal.currentValue !== (goal.startValue ?? 0);
  const mode =
    drives && goal.progressMode === "manual"
      ? manualValue && goal.progressType === "numeric"
        ? "hybrid"
        : "linked"
      : !drives && goal.progressMode !== "manual"
        ? "manual"
        : null;
  return mode ? provider(env).update(goal.id, { progressMode: mode }) : goal;
}

async function resolveHabits(
  env: ToolRunEnv,
  list: { habit: string; useForProgress: boolean }[],
  goal: Pick<NewGoal, "progressType" | "direction">,
) {
  const habits = env.providers.get("habits", env.binding);
  const out: { id: string; relationship: Relationship }[] = [];
  const notes: string[] = [];
  for (const h of list) {
    const found = pickOne(await habits.find(h.habit), h.habit, "habit", (x) => x.name);
    const drives = h.useForProgress && habitsCanDrive(goal);
    if (h.useForProgress && !drives)
      notes.push(
        `${found.name} is linked as context: habits only count toward numeric goals that go up`,
      );
    out.push({ id: found.id, relationship: drives ? "supports" : "related" });
  }
  return { links: out, notes };
}

/** Records a manual change in the goal's history (append-only). */
async function recordValue(
  env: ToolRunEnv,
  goalId: string,
  previous: number | null,
  next: number | null,
  note?: string | null,
) {
  if (previous === next) return;
  await provider(env).record?.(goalId, {
    previousValue: previous,
    newValue: next,
    sourceType: "manual",
    note: note ?? null,
  });
}

// ── Results ──────────────────────────────────────────────────────────────────

async function detailOf(env: ToolRunEnv, goal: Goal): Promise<GoalDetail> {
  const p = provider(env);
  const day = today(env);
  const status = await p.linkedStatus(goal, day, env.ctx.timezone);
  const [events, all, visionList] = await Promise.all([
    p.history?.(goal.id, 100) ?? Promise.resolve([]),
    p.list({ status: "all" }),
    p.listVisions?.({ includeArchived: true }) ?? Promise.resolve([]),
  ]);
  const ref = (g: { id: string; title: string; icon?: string | null }): GoalRef => ({
    id: g.id,
    title: g.title,
    icon: g.icon ?? null,
  });
  const byId = new Map(all.map((g) => [g.id, g]));
  const parent = goal.parentGoalId ? byId.get(goal.parentGoalId) : undefined;
  const relatedIds = new Set([
    ...goal.links.filter((l) => l.resourceType === "goal").map((l) => l.resourceId),
    ...all
      .filter((g) => g.links.some((l) => l.resourceType === "goal" && l.resourceId === goal.id))
      .map((g) => g.id),
  ]);
  return {
    snapshot: snapshot(goal, status, day),
    history: progressSeries(goal, events, status.contributions ?? [], env.ctx.timezone),
    events: events.slice(0, 20),
    visions: visionList.filter((v) => visionIdsOf(goal).includes(v.id)).map(ref),
    parent: parent ? ref(parent) : null,
    children: all
      .filter((g) => g.parentGoalId === goal.id)
      .map((g) => ({
        ...ref(g),
        percent: goalProgress(g, NO_LINKS).percent,
        status: g.status,
      })),
    related: [...relatedIds].flatMap((id) => (byId.get(id) ? [ref(byId.get(id)!)] : [])),
    today: day,
  };
}

/** One goal: its Surface (goal:<id>) is updated in place by every later change. */
async function goalResult(env: ToolRunEnv, goal: Goal, extra: Record<string, unknown> = {}) {
  const detail = await detailOf(env, goal);
  return {
    output: {
      ...extra,
      goal: forModel(detail.snapshot, new Map(detail.visions.map((v) => [v.id, v.title]))),
      ...(detail.history.length > 1
        ? { history: detail.history.slice(-8).map((h) => `${h.date}: ${h.value}`) }
        : {}),
      ...(detail.parent ? { contributesTo: detail.parent.title } : {}),
      ...(detail.children.length ? { contributingGoals: detail.children.map((c) => c.title) } : {}),
      ...(detail.snapshot.health.reached && detail.snapshot.goal.status === "active"
        ? { note: "Target reached. Ask whether to mark it completed; don't complete it yourself." }
        : {}),
    },
    display: { kind: "goal" as const, detail },
    target: { type: "goal", id: goal.id },
  };
}

// ── Reads ────────────────────────────────────────────────────────────────────

export const listGoalsTool: ToolDefinition = {
  name: "goals.list",
  capability: "goals",
  operation: "list",
  description:
    '"¿Cómo vengo con mis objetivos de este trimestre?", "¿qué objetivos están atrasados?" (status at_risk), "mis logros" (completed): goals with progress, health (on track / at risk and why), deadlines and Visions — all computed by ELISE. Draws the goals overview.',
  input: listGoalsInput,
  async describe() {
    return { summary: "List goals" };
  },
  async run(raw, env) {
    const q = listGoalsInput.parse(raw);
    const p = provider(env);
    const day = today(env);
    const archived = q.status === "archived";
    const [goals, visionList] = await Promise.all([
      p.list({ status: q.status === "cancelled" ? "cancelled" : "all", archived }),
      p.listVisions?.({ includeArchived: false }) ?? Promise.resolve([]),
    ]);
    const range = periodOf(q, day) ?? null;
    const vision = q.vision ? await resolveVision(env, q.vision) : null;
    const all = await snapshotsOf(env, goals);
    const shown = sortGoals(
      filterGoals(
        all,
        {
          status: q.status === "cancelled" ? "all" : q.status,
          range,
          visionId: vision?.id ?? null,
          area: q.area ?? null,
        },
        visionList,
      ),
      "attention",
    );
    const titles = new Map(visionList.map((v) => [v.id, v.title]));
    const summary = goalsSummary(shown);
    return {
      output: {
        ...(range ? { range: `${range.from} → ${range.to}` } : {}),
        ...(vision ? { vision: vision.title } : {}),
        summary,
        goals: shown.slice(0, 30).map((s) => forModel(s, titles)),
        ...(shown.length > 30 ? { more: shown.length - 30 } : {}),
        ...(!vision && visionList.length
          ? {
              visions: visionSummaries(visionList, all).map(
                (v) => `${v.vision.title}: ${v.active} active, ${v.completed} completed`,
              ),
            }
          : {}),
      },
      display: {
        kind: "goals" as const,
        goals: shown,
        visions: visionSummaries(visionList, all),
        summary,
        scope: {
          status: q.status,
          from: range?.from ?? null,
          to: range?.to ?? null,
          visionId: vision?.id ?? null,
        },
      },
    };
  },
};

export const goalProgressTool: ToolDefinition = {
  name: "goals.getProgress",
  capability: "goals",
  operation: "getProgress",
  description:
    '"¿Cómo vengo con el objetivo de clientes?": one goal in depth — progress and where it comes from (manual / linked habits and tasks), health, history, related habits this week, Visions and related goals. Shows the goal.',
  input: goalRefInput,
  async describe() {
    return { summary: "Goal progress" };
  },
  async run(raw, env) {
    return goalResult(env, await resolve(env, goalRefInput.parse(raw).goal));
  },
};

// ── Writes ───────────────────────────────────────────────────────────────────

export const createGoalTool: ToolDefinition = {
  name: "goals.create",
  capability: "goals",
  operation: "create",
  description:
    'Create a goal — fast, without asking for what can be inferred. "Conseguir 12 clientes este año" → numeric, targetValue 12, metric "clientes", period this_year. "Publicar 8 artículos en T4" → q4. "Correr una media maratón en menos de 1:45" → numeric, startValue current time, targetValue 105, metric "minutes", direction decrease. "Alcanzar ARS 10.000.000 mensuales" → numeric, currency ARS, targetValue 10000000. "Lanzar la web" → binary. Pass `visions` when the goal clearly belongs to one (it links only an unambiguous match) and `habits` the user mentions.',
  input: createGoalInput,
  async describe(raw) {
    return { summary: `Create goal “${createGoalInput.parse(raw).title}”` };
  },
  async run(raw, env) {
    const g = createGoalInput.parse(raw);
    const day = today(env);
    const period = periodOf(g, day);
    const parent = g.parentGoal ? await resolve(env, g.parentGoal) : null;
    const fields: NewGoal = {
      title: g.title,
      description: g.description ?? null,
      icon: g.icon ?? suggestGoalIcon(g.title) ?? "🎯",
      area: g.area ?? null,
      periodStart: period?.from ?? null,
      periodEnd: period?.to ?? null,
      // The deadline follows the period's end unless the user gave another one.
      targetDate: g.targetDate ?? period?.to ?? null,
      progressType: g.progressType,
      progressMode: g.progressMode,
      startValue: g.startValue ?? (g.direction === "decrease" ? (g.currentValue ?? null) : null),
      // A measured goal starts where it starts: 0 (or today's value to reduce from), so it shows
      // "0 / 12" and its history begins there. Done / not done has no value.
      currentValue:
        g.currentValue ??
        (g.progressType === "binary"
          ? null
          : g.direction === "decrease"
            ? (g.startValue ?? null)
            : (g.startValue ?? 0)),
      targetValue: g.progressType === "percentage" ? 100 : (g.targetValue ?? null),
      direction: g.direction,
      metric: g.metric ?? null,
      currency: g.currency ?? null,
      parentGoalId: parent?.id ?? null,
    };
    validate(fields);
    const habits = g.habits?.length ? await resolveHabits(env, g.habits, fields) : null;
    const notes = [...(habits?.notes ?? [])];
    let goal = await provider(env).create(fields, sourceOf(env.ctx));
    await recordValue(env, goal.id, null, goal.currentValue);
    // A Vision is linked only when the name points to exactly one; otherwise ELISE says so.
    const linkedVisions: { id: string; relationship: Relationship }[] = [];
    for (const name of g.visions ?? []) {
      const matches = (await provider(env).findVision?.(name)) ?? [];
      if (matches.length === 1)
        linkedVisions.push({ id: matches[0]!.id, relationship: "supports" });
      else
        notes.push(
          matches.length
            ? `Vision "${name}" is ambiguous (${matches.map((m) => m.title).join("; ")}): not linked`
            : `No Vision called "${name}": not linked`,
        );
    }
    if (linkedVisions.length) await syncLinks(env, goal, "vision", linkedVisions);
    if (habits?.links.length) await syncLinks(env, goal, "habit", habits.links);
    if (linkedVisions.length || habits?.links.length) {
      goal = (await provider(env).find(goal.id))[0] ?? goal;
      goal = await alignMode(env, goal);
    }
    return goalResult(env, goal, { created: true, ...(notes.length ? { notes } : {}) });
  },
};

export const updateGoalTool: ToolDefinition = {
  name: "goals.update",
  capability: "goals",
  operation: "update",
  description:
    'Change a goal: title, icon, area, period ("movelo al próximo trimestre" → period next_quarter; the deadline follows), deadline, target, measure, parent ("contribuye a…"), and — replacing the whole set — its Visions, habits and related goals. For a new progress value use goals.updateProgress.',
  input: updateGoalInput,
  async describe(raw) {
    return { summary: `Update goal “${updateGoalInput.parse(raw).goal}”` };
  },
  async run(raw, env) {
    const {
      goal: ref,
      period,
      year,
      from,
      to,
      parentGoal,
      visions: visionRefs,
      habits: habitRefs,
      relatedGoals,
      ...fields
    } = updateGoalInput.parse(raw);
    const goal = await resolve(env, ref);
    const p = provider(env);
    const patch: GoalPatch = { ...fields };
    const previous = goal.currentValue;
    const dates = periodOf({ period, year, from, to }, today(env));
    if (dates !== undefined) {
      patch.periodStart = dates?.from ?? null;
      patch.periodEnd = dates?.to ?? null;
      // A deadline that followed the old period follows the new one.
      if (
        fields.targetDate === undefined &&
        (!goal.targetDate || goal.targetDate === goal.periodEnd)
      )
        patch.targetDate = dates?.to ?? null;
    }
    if (fields.targetDate === null) patch.targetDate = patch.periodEnd ?? goal.periodEnd ?? null;
    if (fields.progressType === "percentage") patch.targetValue = 100;
    if (parentGoal !== undefined) {
      const parent = parentGoal ? await resolve(env, parentGoal) : null;
      if (parent) {
        const all = await p.list({ status: "all" });
        if (
          parent.id === goal.id ||
          createsCycle(goal.id, parent.id, new Map(all.map((g) => [g.id, g.parentGoalId])))
        )
          throw new AppError(
            "VALIDATION_ERROR",
            "A goal can't contribute to itself, even indirectly",
            {
              recovery: "review",
            },
          );
      }
      patch.parentGoalId = parent?.id ?? null;
    }
    validate(merged(goal, patch));
    const notes: string[] = [];
    let updated = await p.update(goal.id, patch);
    if (fields.currentValue !== undefined)
      await recordValue(env, goal.id, previous, updated.currentValue);
    if (visionRefs) {
      const ids = [];
      for (const v of visionRefs) ids.push((await resolveVision(env, v)).id);
      await syncLinks(
        env,
        updated,
        "vision",
        ids.map((id) => ({ id, relationship: "supports" })),
      );
    }
    if (habitRefs) {
      const h = await resolveHabits(env, habitRefs, updated);
      notes.push(...h.notes);
      await syncLinks(env, updated, "habit", h.links);
    }
    if (relatedGoals) {
      const ids: string[] = [];
      for (const r of relatedGoals) {
        const other = await resolve(env, r);
        if (other.id !== goal.id) ids.push(other.id);
      }
      // Stored once: a relation the other goal already holds isn't added again.
      const all = await p.list({ status: "all" });
      const held = new Set(
        all
          .filter((g) => g.links.some((l) => l.resourceType === "goal" && l.resourceId === goal.id))
          .map((g) => g.id),
      );
      await syncLinks(
        env,
        updated,
        "goal",
        ids.filter((id) => !held.has(id)).map((id) => ({ id, relationship: "related" })),
      );
    }
    if (visionRefs || habitRefs || relatedGoals) updated = (await p.find(goal.id))[0] ?? updated;
    updated = await alignMode(env, updated);
    return goalResult(env, updated, { updated: true, ...(notes.length ? { notes } : {}) });
  },
};

export const updateProgressTool: ToolDefinition = {
  name: "goals.updateProgress",
  capability: "goals",
  operation: "updateProgress",
  description:
    '"Ya conseguí 7 de los 12 clientes" → value 7. "Sumá un artículo" → add 1. "Bajé a 38 minutos" → value 38. Optional note ("Cerré ACME"). Saved in the goal\'s history. For linked goals this is the manual part added to what habits/tasks contribute.',
  input: progressUpdateInput,
  async describe(raw) {
    return { summary: `Update progress of “${progressUpdateInput.parse(raw).goal}”` };
  },
  async run(raw, env) {
    const u = progressUpdateInput.parse(raw);
    const goal = await resolve(env, u.goal);
    if (goal.progressType === "binary")
      throw new AppError(
        "VALIDATION_ERROR",
        "This goal is done / not done: complete it with goals.complete",
        { recovery: "review" },
      );
    const previous = goal.currentValue;
    const base = previous ?? goal.startValue ?? 0;
    const next = Math.round((u.value ?? base + u.add!) * 100) / 100;
    validate(merged(goal, { currentValue: next }));
    // A linked goal getting a manual value becomes hybrid: both parts stay visible.
    const updated = await provider(env).update(goal.id, {
      currentValue: next,
      ...(goal.progressMode === "linked" && goal.progressType === "numeric"
        ? { progressMode: "hybrid" as const }
        : {}),
    });
    await recordValue(env, goal.id, previous, next, u.note);
    return goalResult(env, updated, { updated: true, previous });
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
    case "vision":
      return (await resolveVision(env, ref)).id;
    case "note":
      return pickOne(
        await env.providers.get("notes", env.binding).find(ref),
        ref,
        "note",
        (n) => n.title,
      ).id;
    case "task": {
      const tasks = await provider(env).findTasks(ref);
      return pickOne(tasks, ref, "ELISE task", (t) => t.title).id;
    }
  }
}

export const linkResourceTool: ToolDefinition = {
  name: "goals.linkResource",
  capability: "goals",
  operation: "linkResource",
  description:
    'Relate a goal to an existing habit, ELISE task, note, Vision or another goal ("relacioná Workout con mi objetivo de entrenar", "eso pertenece a la visión Firbot Solutions"). Nothing is copied. Habits count toward progress only with useForProgress (and only for numeric goals that go up); otherwise they are context. For "contribuye a otro objetivo" use goals.update parentGoal.',
  input: linkInput,
  async describe(raw) {
    const l = linkInput.parse(raw);
    return { summary: `Link ${l.resourceType} “${l.resource}” to “${l.goal}”` };
  },
  async run(raw, env) {
    const l = linkInput.parse(raw);
    const goal = await resolve(env, l.goal);
    const resourceId = await resolveResource(env, l.resourceType, l.resource);
    const notes: string[] = [];
    let relationship: Relationship = l.relationship ?? "supports";
    if (l.resourceType === "habit" || l.resourceType === "task") {
      const wants =
        l.useForProgress ?? (l.resourceType === "task" ? relationship !== "related" : false);
      const can = l.resourceType === "task" || habitsCanDrive(goal);
      if (wants && !can)
        notes.push("Linked as context: habits only count toward numeric goals that go up");
      relationship =
        wants && can ? (l.relationship === "milestone" ? "milestone" : "supports") : "related";
    }
    if (l.resourceType === "goal") {
      if (resourceId === goal.id)
        throw new AppError("VALIDATION_ERROR", "A goal can't be related to itself", {
          recovery: "review",
        });
      const other = (await provider(env).find(resourceId))[0];
      if (other?.links.some((x) => x.resourceType === "goal" && x.resourceId === goal.id))
        return goalResult(env, goal, { linked: true, note: "Already related" });
      relationship = "related";
    }
    let updated = await provider(env).link(goal.id, {
      resourceType: l.resourceType,
      resourceId,
      relationship,
    });
    updated = await alignMode(env, updated);
    return goalResult(env, updated, { linked: true, ...(notes.length ? { notes } : {}) });
  },
};

export const unlinkResourceTool: ToolDefinition = {
  name: "goals.unlinkResource",
  capability: "goals",
  operation: "unlinkResource",
  description:
    "Remove a relation between a goal and a habit/task/note/Vision/goal (both records stay).",
  input: unlinkInput,
  async describe(raw) {
    const l = unlinkInput.parse(raw);
    return { summary: `Unlink “${l.resource}” from “${l.goal}”` };
  },
  async run(raw, env) {
    const l = unlinkInput.parse(raw);
    const goal = await resolve(env, l.goal);
    const wanted = l.resource.toLowerCase();
    const link = goal.links.find(
      (x) =>
        x.resourceType === l.resourceType &&
        (x.resourceId === l.resource || x.title?.toLowerCase().includes(wanted)),
    );
    if (!link) throw new AppError("NOT_FOUND", "That link doesn't exist", { recovery: "review" });
    const updated = await alignMode(env, await provider(env).unlink(goal.id, link));
    return goalResult(env, updated);
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
      return goalResult(env, await provider(env).update(goal.id, { status }));
    },
  };
}

export const completeGoalTool = statusTool(
  "complete",
  "completed",
  "Mark a goal as achieved (kept in Logros with its completion date).",
);
export const pauseGoalTool = statusTool(
  "pause",
  "paused",
  "Pause a goal. Resume it later with goals.update status active.",
);

export const archiveGoalTool: ToolDefinition = {
  name: "goals.archive",
  capability: "goals",
  operation: "archive",
  description: "Archive a goal (kept in history, restorable). Needs the user's approval.",
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

export const restoreGoalTool: ToolDefinition = {
  name: "goals.restore",
  capability: "goals",
  operation: "restore",
  description: "Bring an archived goal back (its history is intact).",
  input: goalRefInput,
  async describe(raw) {
    return { summary: `Restore goal “${goalRefInput.parse(raw).goal}”` };
  },
  async run(raw, env) {
    const ref = goalRefInput.parse(raw).goal;
    const p = provider(env);
    const archived = await p.list({ status: "all", archived: true });
    const goal = pickOne(
      archived.filter((g) => g.id === ref || g.title.toLowerCase().includes(ref.toLowerCase())),
      ref,
      "archived goal",
      (g) => g.title,
    );
    if (!p.unarchive) throw new AppError("CAPABILITY_UNAVAILABLE", "Not supported here");
    return goalResult(env, await p.unarchive(goal.id));
  },
};

export const deleteGoalTool: ToolDefinition = {
  name: "goals.delete",
  capability: "goals",
  operation: "delete",
  description:
    "Delete a goal and its history for good. Only when the user explicitly says delete/borrar (archive keeps it). Needs approval.",
  input: goalRefInput,
  async describe(raw, env) {
    const goal = await resolve(env, goalRefInput.parse(raw).goal);
    return {
      summary: `Delete goal “${goal.title}” and its history`,
      target: { type: "goal", id: goal.id },
    };
  },
  async run(raw, env) {
    const goal = await resolve(env, goalRefInput.parse(raw).goal);
    const p = provider(env);
    if (!p.remove) throw new AppError("CAPABILITY_UNAVAILABLE", "Not supported here");
    await p.remove(goal.id);
    return { output: { deleted: goal.title }, target: { type: "goal", id: goal.id } };
  },
};

// ── Visions ──────────────────────────────────────────────────────────────────

async function visionResult(env: ToolRunEnv, vision: Vision, extra: Record<string, unknown> = {}) {
  const goals = (await provider(env).list({ status: "all" })).filter((g) =>
    visionIdsOf(g).includes(vision.id),
  );
  const snaps = sortGoals(await snapshotsOf(env, goals), "attention");
  const habits = [
    ...new Map(snaps.flatMap((s) => s.habits).map((h) => [h.id ?? h.name, h])).values(),
  ];
  const detail: VisionDetail = { vision, goals: snaps, habits, today: today(env) };
  return {
    output: {
      ...extra,
      vision: {
        visionId: vision.id,
        title: vision.title,
        status: vision.status,
        ...(vision.description ? { description: vision.description } : {}),
        ...(vision.area ? { area: vision.area } : {}),
      },
      goals: snaps.map((s) => forModel(s)),
      summary: `${snaps.filter((s) => s.goal.status === "completed").length} of ${snaps.length} linked goals completed`,
      ...(habits.length
        ? { habitsThisWeek: habits.map((h) => `${h.name} ${h.done}/${h.goal}`) }
        : {}),
      note: "A Vision is qualitative: describe its goals' progress; never give the Vision a percentage.",
    },
    display: { kind: "vision" as const, detail },
    target: { type: "vision", id: vision.id },
  };
}

export const getVisionTool: ToolDefinition = {
  name: "goals.getVision",
  capability: "goals",
  operation: "getVision",
  description:
    '"¿Cómo vengo con Firbot Solutions?" when it names a Vision: the Vision, the goals advancing it with their progress and health, and the habits behind them. Shows the Vision.',
  input: visionRefInput,
  async describe() {
    return { summary: "Vision" };
  },
  async run(raw, env) {
    return visionResult(env, await resolveVision(env, visionRefInput.parse(raw).vision));
  },
};

export const createVisionTool: ToolDefinition = {
  name: "goals.createVision",
  capability: "goals",
  operation: "createVision",
  description:
    'Create a Vision: a long-term, qualitative direction ("Firbot Academy es la academia de bots de referencia en habla hispana"). No metric or deadline. Concrete measurable outcomes are goals instead.',
  input: createVisionInput,
  async describe(raw) {
    return { summary: `Create Vision “${createVisionInput.parse(raw).title.slice(0, 80)}”` };
  },
  async run(raw, env) {
    const v = createVisionInput.parse(raw);
    const p = provider(env);
    if (!p.createVision) throw new AppError("CAPABILITY_UNAVAILABLE", "Not supported here");
    const vision = await p.createVision(
      {
        title: v.title,
        description: v.description ?? null,
        icon: v.icon ?? suggestGoalIcon(v.title) ?? "🧭",
        area: v.area ?? null,
      },
      sourceOf(env.ctx),
    );
    return visionResult(env, vision, { created: true });
  },
};

export const updateVisionTool: ToolDefinition = {
  name: "goals.updateVision",
  capability: "goals",
  operation: "updateVision",
  description:
    "Change a Vision's statement, description, icon or area, or mark it achieved / archived / active.",
  input: updateVisionInput,
  async describe(raw) {
    return { summary: `Update Vision “${updateVisionInput.parse(raw).vision.slice(0, 80)}”` };
  },
  async run(raw, env) {
    const { vision: ref, ...patch } = updateVisionInput.parse(raw);
    const vision = await resolveVision(env, ref);
    const p = provider(env);
    if (!p.updateVision) throw new AppError("CAPABILITY_UNAVAILABLE", "Not supported here");
    return visionResult(env, await p.updateVision(vision.id, patch), { updated: true });
  },
};

export const deleteVisionTool: ToolDefinition = {
  name: "goals.deleteVision",
  capability: "goals",
  operation: "deleteVision",
  description:
    "Delete a Vision for good (its goals stay; they just stop pointing to it). Only when the user asks to delete; archiving is updateVision status archived. Needs approval.",
  input: visionRefInput,
  async describe(raw, env) {
    const v = await resolveVision(env, visionRefInput.parse(raw).vision);
    return {
      summary: `Delete Vision “${v.title.slice(0, 80)}”`,
      target: { type: "vision", id: v.id },
    };
  },
  async run(raw, env) {
    const v = await resolveVision(env, visionRefInput.parse(raw).vision);
    const p = provider(env);
    if (!p.removeVision) throw new AppError("CAPABILITY_UNAVAILABLE", "Not supported here");
    await p.removeVision(v.id);
    return { output: { deleted: v.title }, target: { type: "vision", id: v.id } };
  },
};

// ── Habit side: "Objetivos relacionados" ─────────────────────────────────────

/**
 * Makes a habit related to exactly these goals (the habit form sends the full set). The same
 * goal_links rows the goal side uses, so both directions always agree.
 */
export async function syncHabitGoals(
  env: ToolRunEnv,
  habitId: string,
  wanted: { goal: string; useForProgress: boolean }[],
): Promise<string[]> {
  const p = provider(env);
  const notes: string[] = [];
  const targets = new Map<string, boolean>();
  for (const w of wanted) targets.set((await resolve(env, w.goal)).id, w.useForProgress);
  for (const goal of await p.list({ status: "all" })) {
    const link = goal.links.find((l) => l.resourceType === "habit" && l.resourceId === habitId);
    const want = targets.get(goal.id);
    if (want === undefined) {
      if (link) await alignMode(env, await p.unlink(goal.id, link));
      continue;
    }
    const drives = want && habitsCanDrive(goal);
    if (want && !drives)
      notes.push(`"${goal.title}" isn't counted from habits (not a number that goes up)`);
    const relationship: Relationship = drives ? "supports" : "related";
    if (!link || link.relationship !== relationship)
      await alignMode(
        env,
        await p.link(goal.id, { resourceType: "habit", resourceId: habitId, relationship }),
      );
  }
  return notes;
}

export const GOAL_TOOLS = [
  listGoalsTool,
  goalProgressTool,
  createGoalTool,
  updateGoalTool,
  updateProgressTool,
  linkResourceTool,
  unlinkResourceTool,
  completeGoalTool,
  pauseGoalTool,
  archiveGoalTool,
  restoreGoalTool,
  deleteGoalTool,
  getVisionTool,
  createVisionTool,
  updateVisionTool,
  deleteVisionTool,
];

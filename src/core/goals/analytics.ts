import type {
  Goal,
  GoalProgress,
  LinkedStatus,
  ProgressEvent,
  Vision,
} from "../capabilities/goals";
import { dayMet, type Habit, type HabitEntry } from "../capabilities/habits";
import type { Period } from "../periods";
import { todayIn } from "../time";
import { daysBetween, resolveGoalPeriod, type GoalPeriodPreset } from "./periods";

/**
 * Goals analytics (ADR-055): one deterministic layer for the Goals screen, the goal tools
 * (Chat + Canvas) and the Morning Brief. The model explains these numbers; it never computes
 * them, and never assigns a status.
 */

export type HealthState =
  | "not_started"
  | "in_progress"
  | "on_track"
  | "at_risk"
  | "completed"
  | "paused"
  | "cancelled"
  | "archived";

export type HealthReason =
  | { kind: "pace"; elapsed: number; progress: number }
  | { kind: "overdue"; deadline: string }
  | { kind: "starts"; date: string };

export interface GoalHealth {
  state: HealthState;
  /** Why it is at risk / not started; null when there is nothing to explain. */
  reason: HealthReason | null;
  /** The target is met (completing is still the user's call). */
  reached: boolean;
  /** Share of the goal's window already past, 0–1; null without a deadline. */
  elapsed: number | null;
  /** Days until the deadline (negative once past); null without one. */
  daysLeft: number | null;
}

/** The goal's active window: its period (or creation day) to its deadline (or period end). */
export function goalWindow(goal: Goal): { from: string; to: string | null } {
  return {
    from: goal.periodStart ?? goal.createdAt.slice(0, 10),
    to: goal.targetDate ?? goal.periodEnd ?? null,
  };
}

/** Too early to judge a pace before a quarter of the window has passed. */
const MIN_ELAPSED = 0.25;
/** How far behind the elapsed share of time progress may be before it is at risk. */
const BEHIND = 0.15;

/**
 * Health, by rules anyone can check:
 * - archived / completed / paused / cancelled come from the goal itself;
 * - not started: its period begins later, or nothing measured yet early in the window;
 * - at risk: past its deadline without reaching the target, or — after a quarter of the
 *   window — more than 15 points behind the time elapsed ("Queda 25% del período y llevás
 *   20%"). A straight line from start to deadline: simple to explain, no prediction;
 * - on track: measured and keeping pace (or the target is already reached);
 * - in progress: active, but nothing to measure a pace with (binary goals, no deadline).
 */
export function goalHealth(goal: Goal, progress: GoalProgress, today: string): GoalHealth {
  const { from, to } = goalWindow(goal);
  const daysLeft = to ? daysBetween(today, to) : null;
  const total = to ? daysBetween(from, to) + 1 : null;
  const elapsed =
    total && total > 0 ? Math.max(0, Math.min(1, (daysBetween(from, today) + 1) / total)) : null;
  const base = { reached: progress.reached, elapsed, daysLeft };
  if (goal.archived) return { ...base, state: "archived", reason: null };
  if (goal.status !== "active") return { ...base, state: goal.status, reason: null };
  if (from > today)
    return { ...base, state: "not_started", reason: { kind: "starts", date: from } };
  if (progress.reached) return { ...base, state: "on_track", reason: null };
  if (to && to < today)
    return { ...base, state: "at_risk", reason: { kind: "overdue", deadline: to } };
  const measurable =
    progress.percent !== null &&
    !(goal.progressType === "binary" && goal.progressMode === "manual");
  if (!measurable) return { ...base, state: "in_progress", reason: null };
  const done = progress.percent! / 100;
  if (elapsed === null || elapsed < MIN_ELAPSED)
    return { ...base, state: done > 0 ? "on_track" : "not_started", reason: null };
  return done < elapsed - BEHIND
    ? { ...base, state: "at_risk", reason: { kind: "pace", elapsed, progress: done } }
    : { ...base, state: "on_track", reason: null };
}

/** The risk reason in words, for the model ("75% of the period passed, 20% done"). */
export function healthText(h: GoalHealth): string | null {
  const r = h.reason;
  if (!r)
    return h.reached && h.state === "on_track" ? "target reached — suggest completing it" : null;
  if (r.kind === "overdue") return `deadline ${r.deadline} passed without reaching the target`;
  if (r.kind === "starts") return `its period starts ${r.date}`;
  return `${Math.round((1 - r.elapsed) * 100)}% of the period left, ${Math.round(r.progress * 100)}% of the goal done`;
}

/** A goal with everything the screens, the tools and the brief show. */
export interface GoalSnapshot {
  goal: Goal;
  progress: GoalProgress;
  health: GoalHealth;
  openTasks: number;
  habits: LinkedStatus["habits"];
}

export interface GoalRef {
  id: string;
  title: string;
  icon: string | null;
}

/** One goal in depth: the goal detail, the goal Surface and goals.getProgress. */
export interface GoalDetail {
  snapshot: GoalSnapshot;
  /** Value over time (oldest first). */
  history: ProgressPoint[];
  /** The latest history entries, newest first. */
  events: ProgressEvent[];
  visions: GoalRef[];
  /** "Contribuye a". */
  parent: GoalRef | null;
  /** Goals that contribute to this one. */
  children: (GoalRef & { percent: number | null; status: Goal["status"] })[];
  /** "Relacionado con" (either direction). */
  related: GoalRef[];
  today: string;
}

/** Where a Vision stands: its goals and the habits behind them — never a completion %. */
export interface VisionDetail {
  vision: Vision;
  goals: GoalSnapshot[];
  habits: LinkedStatus["habits"];
  today: string;
}

/** A goal as cards and Surfaces show it: plain values, every number already computed. */
export interface GoalCard {
  id: string;
  title: string;
  icon: string | null;
  status: Goal["status"] | "archived";
  health: HealthState;
  reason: { kind: HealthReason["kind"]; elapsed?: number; progress?: number; date?: string } | null;
  percent: number | null;
  value: number | null;
  target: number | null;
  progressType: Goal["progressType"];
  direction: Goal["direction"];
  basis: GoalProgress["basis"];
  unit: string | null;
  currency: string | null;
  periodFrom: string | null;
  periodTo: string | null;
  deadline: string | null;
  reached: boolean;
  visions: string[];
  area: string | null;
  habits: { name: string; icon: string | null; done: number; goal: number; drives: boolean }[];
  completedAt: string | null;
}

const clipTo = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function goalCard(s: GoalSnapshot, visionTitles: ReadonlyMap<string, string>): GoalCard {
  const { goal, progress, health } = s;
  const r = health.reason;
  return {
    id: goal.id,
    title: clipTo(goal.title, 300),
    icon: goal.icon ?? null,
    status: goal.archived ? "archived" : goal.status,
    health: health.state,
    reason: !r
      ? null
      : r.kind === "pace"
        ? { kind: "pace", elapsed: r.elapsed, progress: r.progress }
        : { kind: r.kind, date: r.kind === "overdue" ? r.deadline : r.date },
    percent: progress.percent,
    value: progress.value,
    target: goal.progressType === "percentage" ? 100 : goal.targetValue,
    progressType: goal.progressType,
    direction: goal.direction,
    basis: progress.basis,
    unit: goal.metric ? clipTo(goal.metric, 60) : null,
    currency: goal.currency ?? null,
    periodFrom: goal.periodStart ?? null,
    periodTo: goal.periodEnd ?? null,
    deadline: goal.targetDate,
    reached: health.reached,
    visions: visionIdsOf(goal)
      .map((id) => visionTitles.get(id))
      .filter((t): t is string => Boolean(t))
      .slice(0, 5)
      .map((t) => clipTo(t, 500)),
    area: goal.area ?? null,
    habits: s.habits.slice(0, 6).map((h) => ({
      name: clipTo(h.name, 120),
      icon: h.icon ?? null,
      done: h.done,
      goal: h.goal,
      drives: Boolean(h.drives),
    })),
    completedAt: goal.completedAt,
  };
}

export const visionIdsOf = (g: Goal) =>
  g.links.filter((l) => l.resourceType === "vision").map((l) => l.resourceId);

// ── Filters, sorting, summary ────────────────────────────────────────────────

export type GoalStatusFilter = "all" | "active" | "at_risk" | "completed" | "paused" | "archived";

export interface GoalFilter {
  status?: GoalStatusFilter;
  /** Only goals whose window overlaps this range. */
  range?: Period | null;
  visionId?: string | null;
  area?: string | null;
  habitId?: string | null;
  query?: string | null;
}

const norm = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** Does the goal's window overlap the range? A goal with no end is open-ended. */
export function inRange(goal: Goal, range: Period): boolean {
  const w = goalWindow(goal);
  return w.from <= range.to && (w.to === null || w.to >= range.from);
}

export function matchesStatus(s: GoalSnapshot, status: GoalStatusFilter): boolean {
  const g = s.goal;
  if (status === "archived") return Boolean(g.archived);
  if (g.archived) return false;
  switch (status) {
    case "all":
      return true;
    case "active":
      return g.status === "active";
    case "at_risk":
      return s.health.state === "at_risk";
    case "completed":
      return g.status === "completed";
    case "paused":
      return g.status === "paused";
  }
}

export function filterGoals(
  snaps: GoalSnapshot[],
  f: GoalFilter,
  visions: Pick<Vision, "id" | "title">[] = [],
): GoalSnapshot[] {
  const q = f.query?.trim() ? norm(f.query.trim()) : null;
  const visionTitle = new Map(visions.map((v) => [v.id, v.title]));
  return snaps.filter((s) => {
    const g = s.goal;
    if (f.status && !matchesStatus(s, f.status)) return false;
    if (f.range && !inRange(g, f.range)) return false;
    if (f.visionId && !visionIdsOf(g).includes(f.visionId)) return false;
    if (f.area && norm(g.area ?? "") !== norm(f.area)) return false;
    if (f.habitId && !g.links.some((l) => l.resourceType === "habit" && l.resourceId === f.habitId))
      return false;
    if (q) {
      const hay = norm(
        [
          g.title,
          g.description ?? "",
          g.area ?? "",
          ...visionIdsOf(g).map((id) => visionTitle.get(id) ?? ""),
        ].join(" "),
      );
      if (!q.split(/\s+/).every((w) => hay.includes(w))) return false;
    }
    return true;
  });
}

export const GOAL_SORTS = ["attention", "progress", "deadline", "created", "title"] as const;
export type GoalSort = (typeof GOAL_SORTS)[number];

const RANK: Record<HealthState, number> = {
  at_risk: 0,
  on_track: 1,
  in_progress: 2,
  not_started: 3,
  paused: 4,
  completed: 5,
  cancelled: 6,
  archived: 7,
};

/** Attention: at risk first, then target reached (waiting to be completed), then soonest due. */
export function sortGoals(snaps: GoalSnapshot[], by: GoalSort): GoalSnapshot[] {
  const due = (s: GoalSnapshot) => goalWindow(s.goal).to ?? "9999-12-31";
  const cmp: Record<GoalSort, (a: GoalSnapshot, b: GoalSnapshot) => number> = {
    attention: (a, b) =>
      RANK[a.health.state] - RANK[b.health.state] ||
      Number(b.health.reached) - Number(a.health.reached) ||
      due(a).localeCompare(due(b)) ||
      (a.progress.percent ?? 101) - (b.progress.percent ?? 101),
    progress: (a, b) => (b.progress.percent ?? -1) - (a.progress.percent ?? -1),
    deadline: (a, b) => due(a).localeCompare(due(b)),
    created: (a, b) => b.goal.createdAt.localeCompare(a.goal.createdAt),
    title: (a, b) => a.goal.title.localeCompare(b.goal.title),
  };
  return [...snaps].sort(cmp[by]);
}

export interface GoalsSummary {
  active: number;
  atRisk: number;
  completed: number;
  paused: number;
  /** Mean percent of active goals that can be measured; null when none can. */
  averageProgress: number | null;
  byState: Partial<Record<HealthState, number>>;
}

export function goalsSummary(snaps: GoalSnapshot[]): GoalsSummary {
  const live = snaps.filter((s) => !s.goal.archived);
  const active = live.filter((s) => s.goal.status === "active");
  const measured = active.filter(
    (s) => s.health.state !== "in_progress" && s.progress.percent !== null,
  );
  const byState: GoalsSummary["byState"] = {};
  for (const s of live) byState[s.health.state] = (byState[s.health.state] ?? 0) + 1;
  return {
    active: active.length,
    atRisk: active.filter((s) => s.health.state === "at_risk").length,
    completed: live.filter((s) => s.goal.status === "completed").length,
    paused: live.filter((s) => s.goal.status === "paused").length,
    averageProgress: measured.length
      ? Math.round(measured.reduce((a, s) => a + s.progress.percent!, 0) / measured.length)
      : null,
    byState,
  };
}

export interface VisionSummary {
  vision: Vision;
  active: number;
  completed: number;
  total: number;
  atRisk: number;
}

/** Linked goals per Vision — counts, never a "Vision completion" percentage. */
export function visionSummaries(visions: Vision[], snaps: GoalSnapshot[]): VisionSummary[] {
  return visions.map((vision) => {
    const own = snaps.filter((s) => !s.goal.archived && visionIdsOf(s.goal).includes(vision.id));
    return {
      vision,
      active: own.filter((s) => s.goal.status === "active").length,
      completed: own.filter((s) => s.goal.status === "completed").length,
      total: own.length,
      atRisk: own.filter((s) => s.health.state === "at_risk").length,
    };
  });
}

/** The range a list filter stands for ("this_quarter" → its dates). */
export function filterRange(
  preset: GoalPeriodPreset | "all",
  today: string,
  custom?: { from?: string; to?: string; year?: number },
): Period | null {
  if (preset === "all" || preset === "none") return null;
  return resolveGoalPeriod(preset, today, custom ?? {}) ?? null;
}

// ── Progress history ─────────────────────────────────────────────────────────

export interface ProgressPoint {
  date: string;
  value: number;
}

/**
 * The goal's value over time: its manual history (events) plus, for linked/hybrid goals, the
 * linked amounts as they accrued. Same rules as `goalProgress`, applied day by day.
 */
export function progressSeries(
  goal: Goal,
  events: ProgressEvent[],
  contributions: { date: string; amount: number }[],
  timezone: string,
): ProgressPoint[] {
  const local = (iso: string) => todayIn(timezone, new Date(iso));
  const manual = [...events]
    .filter((e) => e.newValue !== null)
    .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))
    .map((e) => ({ date: local(e.occurredAt), value: e.newValue! }));
  const linked = goal.progressMode !== "manual" ? contributions : [];
  const dates = [...new Set([...manual.map((m) => m.date), ...linked.map((c) => c.date)])].sort();
  const start = goal.startValue ?? (goal.direction === "decrease" ? null : 0);
  const out: ProgressPoint[] = [];
  for (const date of dates) {
    const m = manual.filter((x) => x.date <= date).at(-1)?.value ?? null;
    const l = linked.filter((c) => c.date <= date).reduce((s, c) => s + c.amount, 0);
    const value =
      goal.progressMode === "manual"
        ? m
        : goal.progressMode === "linked"
          ? (start ?? 0) + l
          : (m ?? start ?? 0) + l;
    if (value !== null) out.push({ date, value: Math.round(value * 100) / 100 });
  }
  return out.slice(-60);
}

// ── Linked contributions ─────────────────────────────────────────────────────

/**
 * What a progress-driving habit adds to a numeric goal inside its window: 1 per met day
 * ("each completed Workout contributes 1"), or the logged quantity when the habit's unit is
 * the goal's metric (km toward "run 300 km"). Dated, so history can be drawn from it.
 */
export function habitContribution(
  habit: Habit,
  entries: HabitEntry[],
  metric: string | null,
  window: { from: string; to: string },
): { date: string; amount: number }[] {
  const sameUnit = Boolean(habit.unit && metric && norm(habit.unit) === norm(metric));
  return entries
    .filter((e) => e.habitId === habit.id && e.date >= window.from && e.date <= window.to)
    .filter((e) => (sameUnit ? e.status === "done" && e.value > 0 : dayMet(habit, e)))
    .map((e) => ({ date: e.date, amount: sameUnit ? e.value : 1 }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

// ── Icons and smart defaults ─────────────────────────────────────────────────

const ICON_WORDS: [RegExp, string][] = [
  [/client|venta|sales|deal|cerrar|propuesta/i, "🤝"],
  [/ingres|revenue|factur|ganar|ahorr|saving|money|dinero|plata|\b(ars|usd|eur)\b|\$/i, "💰"],
  [/art[ií]cul|blog|publicar|post|escrib|write|newsletter|contenid|content/i, "📰"],
  [/leer|libro|read|book/i, "📚"],
  [/curso|estudi|study|aprend|learn|academ|alumn|student|clase/i, "🎓"],
  [/entren|workout|gym|correr|\brun|marat|fitness|f[ií]sic|salud|health|peso|weight|km/i, "🏋️"],
  [/medit|estr[eé]s|calma|mindful|dormir|sleep|bienestar/i, "🧠"],
  [/operac|proces|automat|operations|sistema|system|eficien/i, "⚙️"],
  [/crec|grow|escal|lanz|launch|startup|agencia|empresa|business/i, "🚀"],
  [/viaj|travel|trip/i, "✈️"],
  [/famil|amig|friend|pareja/i, "❤️"],
];

/** A deterministic emoji from the title; the user can change or remove it. */
export function suggestGoalIcon(title: string): string | null {
  return ICON_WORDS.find(([re]) => re.test(title))?.[1] ?? null;
}

export interface GoalDraft {
  progressType?: "binary" | "numeric" | "percentage";
  direction?: "increase" | "decrease";
  targetValue?: number;
  metric?: string;
  currency?: string;
  period?: GoalPeriodPreset;
  /** A custom period's end ("de acá a diciembre"). */
  to?: string;
}

const MONTH_WORDS: [RegExp, number][] = [
  [/enero|january/i, 1],
  [/febrero|february/i, 2],
  [/marzo|march/i, 3],
  [/abril|april/i, 4],
  [/mayo|may/i, 5],
  [/junio|june/i, 6],
  [/julio|july/i, 7],
  [/agosto|august/i, 8],
  [/septiembre|setiembre|september/i, 9],
  [/octubre|october/i, 10],
  [/noviembre|november/i, 11],
  [/diciembre|december/i, 12],
];

/** "10.000.000" / "10,5" / "1,500.50" → a number (es and en separators). */
export function parseAmount(raw: string): number | null {
  let s = raw.trim();
  if (/^\d{1,3}([.,]\d{3})+$/.test(s)) s = s.replace(/[.,]/g, "");
  else if (/,\d{1,2}$/.test(s)) s = s.replace(/\./g, "").replace(",", ".");
  else s = s.replace(/,/g, "");
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Safe form suggestions from a goal's title ("Leer 12 libros este año" → numeric, 12, "libros",
 * this year). Only suggestions: the user confirms them in the normal form.
 */
export function inferGoalDraft(title: string, today: string): GoalDraft {
  const out: GoalDraft = {};
  const money =
    /(?:\b(ars|usd|eur|u\$s)\s*|\$\s*)([\d.,]+)/i.exec(title) ??
    /([\d.,]+)\s*(ars|usd|eur|pesos|d[oó]lares)\b/i.exec(title);
  if (money) {
    const [code, amount] = /^\d/.test(money[1]!)
      ? [money[2]!, money[1]!]
      : [money[1] ?? "$", money[2]!];
    const c = code.toLowerCase();
    out.currency =
      c.startsWith("usd") || c.startsWith("u$s") || c.startsWith("d")
        ? "USD"
        : c === "eur"
          ? "EUR"
          : "ARS";
    const n = parseAmount(amount);
    if (n) out.targetValue = n;
    out.progressType = "numeric";
  } else {
    const pct = /(\d+(?:[.,]\d+)?)\s*%/.exec(title);
    const count = /(?:^|\s)(\d+(?:[.,]\d+)?)\s+([\p{L}]{3,})/u.exec(title);
    if (pct) {
      out.progressType = "numeric";
      out.targetValue = parseAmount(pct[1]!) ?? undefined;
      out.metric = "%";
    } else if (count) {
      out.progressType = "numeric";
      out.targetValue = parseAmount(count[1]!) ?? undefined;
      out.metric = count[2]!.toLowerCase();
    } else out.progressType = "binary";
  }
  if (/\b(reducir|bajar|menos de|bajo|reduce|lower|lose|perder|bajar a)\b/i.test(title))
    out.direction = "decrease";
  if (/\b(este|esta) a[ñn]o\b|\bthis year\b/i.test(title)) out.period = "this_year";
  else if (/\beste trimestre\b|\bthis quarter\b/i.test(title)) out.period = "this_quarter";
  else if (/\bpr[oó]ximo trimestre\b|\bnext quarter\b/i.test(title)) out.period = "next_quarter";
  else if (/\bpr[oó]ximo a[ñn]o\b|\bnext year\b/i.test(title)) out.period = "next_year";
  else if (/\b(?:en|durante|in|for)\s+(3|6|12|tres|seis|doce)\s+(meses|months)\b/i.test(title)) {
    const n = /\b(3|tres)\b/i.test(title) ? 3 : /\b(6|seis)\b/i.test(title) ? 6 : 12;
    out.period = `months_${n}` as GoalPeriodPreset;
  } else if (/\b([TQ])([1-4])\b/.test(title))
    out.period = `q${/\b[TQ]([1-4])\b/.exec(title)![1]}` as GoalPeriodPreset;
  else if (/\b(de ac[aá] a|hasta|antes de|para|by|until|before)\s+\p{L}+/iu.test(title)) {
    const month = MONTH_WORDS.find(([re]) => re.test(title))?.[1];
    if (month) {
      const [y, m] = today.split("-").map(Number) as [number, number];
      const year = month < m ? y + 1 : y;
      const end = new Date(Date.UTC(year, month, 0)).getUTCDate();
      out.period = "custom";
      out.to = `${year}-${String(month).padStart(2, "0")}-${end}`;
    }
  }
  return out;
}

import { AppError } from "../errors";

/**
 * Methods ("Métodos", ADR-040): ELISE's procedural memory — how the user wants a recurring kind
 * of work done. Internally the "skills" domain.
 *
 * - Knowledge is what is true; a Method is how to work. A Method never stores facts about the
 *   user's world (those belong in Knowledge) and never grants anything: it is text that shapes
 *   how ELISE uses the tools she already has, under the same executor, permissions and
 *   approvals.
 * - Scope is where a Method lives: the whole workspace (global), a Knowledge Space, or a
 *   Section. More specific wins.
 * - Only a lightweight index is in context at turn start; the full Method loads when relevant.
 */

export const METHOD_PLATFORMS = ["web", "desktop", "mobile"] as const;
export type MethodPlatform = (typeof METHOD_PLATFORMS)[number];

export const REFERENCE_KINDS = ["reference", "example", "template"] as const;
export type ReferenceKind = (typeof REFERENCE_KINDS)[number];

export const CHANGE_SOURCES = [
  "user_ui",
  "ai_explicit",
  "ai_correction",
  "ai_suggestion",
  "import",
  "restore",
] as const;
export type ChangeSource = (typeof CHANGE_SOURCES)[number];

export type MethodScope = "global" | "space" | "section";

export const METHOD_LIMITS = {
  name: 120,
  description: 300,
  instructions: 12_000,
  /** What ELISE may write herself: a procedure, not a wall of text (ADR-040 §R). */
  generatedInstructions: 6_000,
  hints: 12,
  hint: 60,
  referenceChars: 40_000,
  changeSummary: 200,
} as const;

/** One entry of the lightweight index: never the instructions. */
export interface MethodSummary {
  id: string;
  name: string;
  description: string;
  hints: string[];
  /** null = global (the whole workspace). */
  spaceId: string | null;
  platforms: MethodPlatform[];
  version: number;
  updatedAt: string;
}

export interface Method extends MethodSummary {
  instructions: string;
  status: "active" | "archived";
  changeSummary: string;
  createdAt: string;
}

export interface MethodReference {
  id: string;
  kind: ReferenceKind;
  title: string;
  sourceType: "chat_attachment" | "knowledge_item" | "text";
  mimeType: string | null;
  attachmentId: string | null;
  knowledgeItemId: string | null;
  /** The text ELISE reads; null for a Knowledge document (read live). */
  content: string | null;
  createdAt: string;
}

export interface MethodVersion {
  version: number;
  name: string;
  description: string;
  instructions: string;
  hints: string[];
  spaceId: string | null;
  changeSummary: string;
  changeSource: ChangeSource;
  createdAt: string;
}

/** Why a version exists: what changed, who/what changed it, and from where. */
export interface Provenance {
  source: ChangeSource;
  summary: string;
  ref?: { conversationId?: string | null; aiRunId?: string | null; attachmentId?: string | null };
}

export interface NewMethod {
  name: string;
  description: string;
  instructions: string;
  hints?: string[];
  spaceId?: string | null;
  platforms?: MethodPlatform[];
}

export interface SpaceRef {
  id: string;
  name: string;
  parentId: string | null;
  /** "Space › Section" */
  path: string;
  /** General Knowledge (ADR-047): its Methods are the workspace-wide ones (spaceId null). */
  general?: boolean;
}

/** Persistence port (workspace-shared rows, RLS). Implemented in the application layer. */
export interface MethodStore {
  /** Active Methods, without instructions. */
  index(): Promise<MethodSummary[]>;
  /** Every Method, archived included, without instructions. */
  list(): Promise<(MethodSummary & { status: Method["status"] })[]>;
  get(id: string): Promise<Method>;
  create(input: NewMethod, provenance: Provenance): Promise<Method>;
  /** Content changes create a version (the database counts them). */
  update(id: string, patch: Partial<NewMethod>, provenance: Provenance): Promise<Method>;
  setStatus(id: string, status: Method["status"]): Promise<Method>;
  versions(id: string): Promise<MethodVersion[]>;
  references(id: string): Promise<MethodReference[]>;
  addReference(
    id: string,
    ref:
      | { kind: ReferenceKind; source: "attachment"; attachmentId: string; title?: string }
      | { kind: ReferenceKind; source: "knowledge_item"; itemId: string }
      | { kind: ReferenceKind; source: "text"; title: string; content: string },
  ): Promise<MethodReference>;
  removeReference(id: string, referenceId: string): Promise<void>;
  /** The workspace's active Spaces and Sections, for scope. */
  spaces(): Promise<SpaceRef[]>;
}

// ── Scope ────────────────────────────────────────────────────────────────────

/** 0 = global, 1 = a Space, 2+ = a Section (deeper = more specific). */
export function depthOf(spaceId: string | null, parents: ReadonlyMap<string, string | null>) {
  let depth = 0;
  for (let id: string | null = spaceId; id && depth < 13; id = parents.get(id) ?? null) depth++;
  return depth;
}

export function scopeOf(
  spaceId: string | null,
  parents: ReadonlyMap<string, string | null>,
): MethodScope {
  const d = depthOf(spaceId, parents);
  return d === 0 ? "global" : d === 1 ? "space" : "section";
}

/**
 * The Spaces whose Methods apply here: each given Space or Section and all its ancestors
 * (a Section inherits its Space's Methods), most specific first, without duplicates.
 */
export function scopeChain(
  spaceIds: readonly (string | null | undefined)[],
  parents: ReadonlyMap<string, string | null>,
): string[] {
  const chain: string[] = [];
  for (const start of spaceIds) {
    for (let id = start ?? null, n = 0; id && n < 13; id = parents.get(id) ?? null, n++) {
      if (!chain.includes(id)) chain.push(id);
    }
  }
  return chain.sort((a, b) => depthOf(b, parents) - depthOf(a, parents));
}

/** Deterministic first step: only global Methods and those of the active scope chain. */
export function inScope(index: readonly MethodSummary[], chain: readonly string[]) {
  return index.filter((m) => m.spaceId === null || chain.includes(m.spaceId));
}

// ── Selection ────────────────────────────────────────────────────────────────

const STOPWORDS = new Set(
  (
    "que con para por una uno unos unas los las del como pero mas esta este esto estos estas " +
    "eso esa ese ella ellos sus tus mis muy hay ser son fue era sea the and for with this that " +
    "from into your you our are was were have has had can will would should what when where " +
    "how why who which all any not but its use usa usar hace hacer hacé haceme armame dame " +
    "quiero necesito podes podés please let make get"
  ).split(" "),
);

/** Lowercase, accent-free words of 3+ letters, minus stopwords. */
export function tokens(text: string): string[] {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

/**
 * Same word, loosely: plurals and verb forms share a long prefix ("propuesta"/"propuestas",
 * "preparame"/"preparar", "reunion"/"reuniones"). Words with digits must match exactly.
 */
const same = (a: string, b: string) => {
  if (a === b) return true;
  if (/\d/.test(a) || /\d/.test(b)) return false;
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n >= 5 && n >= 0.75 * Math.min(a.length, b.length);
};

export interface ScoredMethod {
  method: MethodSummary;
  /** Relevance for ranking: matched words, discounted when many candidates share them. */
  score: number;
  /** Raw evidence: 3 per name/hint word, 1 per description word. */
  evidence: number;
  depth: number;
}

export interface MethodSelection {
  /** In scope, best first (what the index shows). */
  candidates: ScoredMethod[];
  /** One Method clearly matches: load it now. */
  selected: ScoredMethod | null;
  /** Equally specific Methods that fit about as well: ELISE asks which. */
  ambiguous: ScoredMethod[] | null;
  /** Less specific Methods for the same work that the selected one overrides here. */
  overridden: MethodSummary[];
  /** Short, for the trace: why this one. */
  reason: string | null;
}

/** A match needs at least one name/hint word, or three description words. */
export const MATCH_THRESHOLD = 3;

/**
 * Picks the Method a request needs (ADR-040 §E/§Q). Deterministic and cheap: scope filtering
 * first, then lexical relevance weighted against how common each word is among the candidates
 * (a word every Method shares, like "preparar", says little). The model ranks what's left from
 * the index; it never sees Methods outside the scope chain.
 *
 * ponytail: lexical relevance only; add stored embeddings when cross-language matching matters.
 */
export function selectMethods(
  index: readonly MethodSummary[],
  input: {
    message: string;
    chain: readonly string[];
    parents: ReadonlyMap<string, string | null>;
    /** The Method the previous turn used: a follow-up keeps it when nothing else matches. */
    recentId?: string | null;
  },
): MethodSelection {
  const scoped = inScope(index, input.chain);
  const words = [...new Set(tokens(input.message))];
  const fields = scoped.map((m) => ({
    strong: [...tokens(m.name), ...m.hints.flatMap(tokens)],
    weak: tokens(m.description),
  }));
  // How many candidates each message word matches (rarer = more telling).
  const df = new Map(
    words.map((w) => [
      w,
      fields.filter((f) => [...f.strong, ...f.weak].some((x) => same(w, x))).length,
    ]),
  );
  const candidates = scoped
    .map((method, i) => {
      const f = fields[i]!;
      let score = 0;
      let evidence = 0;
      for (const w of words) {
        const weight = f.strong.some((x) => same(w, x))
          ? 3
          : f.weak.some((x) => same(w, x))
            ? 1
            : 0;
        evidence += weight;
        if (weight) score += weight / Math.max(1, df.get(w) ?? 1) ** 0.5;
      }
      return { method, score, evidence, depth: depthOf(method.spaceId, input.parents) };
    })
    .sort(
      (a, b) =>
        b.score - a.score || b.depth - a.depth || a.method.name.localeCompare(b.method.name),
    );

  const matched = candidates.filter((c) => c.evidence >= MATCH_THRESHOLD);
  const none: MethodSelection = {
    candidates,
    selected: null,
    ambiguous: null,
    overridden: [],
    reason: null,
  };
  if (!matched.length) {
    const recent = input.recentId ? candidates.find((c) => c.method.id === input.recentId) : null;
    return recent && !candidates.some((c) => c.score > 0 && c !== recent)
      ? { ...none, selected: recent, reason: "continues the previous turn's method" }
      : none;
  }
  // More specific context wins when it covers the same work about as well (a Section's
  // variation over its Space's, a Space's over a global one).
  const deepest = Math.max(...matched.map((c) => c.depth));
  const top = matched[0]!;
  const specific = matched.filter((c) => c.depth === deepest && c.score >= top.score * 0.6);
  const pool = specific.length ? specific : [top];
  const [best, second] = pool;
  if (second && second.score >= best!.score * 0.75)
    return { ...none, ambiguous: pool.filter((c) => c.score >= best!.score * 0.75) };
  const overridden = matched
    .filter((c) => c.depth < best!.depth && c.score >= best!.score * 0.5)
    .map((c) => c.method);
  return {
    candidates,
    selected: best!,
    ambiguous: null,
    overridden,
    reason:
      `matched "${best!.method.name}"` +
      (overridden.length
        ? ` (more specific than ${overridden.map((m) => m.name).join(", ")})`
        : ""),
  };
}

/** How many index lines a turn carries at most: hundreds of Methods never flood the prompt. */
export const INDEX_LINES = 8;

/** The lightweight index for this turn: every in-scope Method when few, else the best few. */
export function indexFor(selection: MethodSelection): ScoredMethod[] {
  const rest = selection.candidates.filter((c) => c !== selection.selected);
  return rest.length <= INDEX_LINES ? rest : rest.filter((c) => c.score > 0).slice(0, INDEX_LINES);
}

export interface TurnMethods {
  /** Load this Method's full content into the turn. */
  load: ScoredMethod | null;
  reason: string | null;
  /** The lightweight index (names and purposes), without the loaded one. */
  index: ScoredMethod[];
  /** In-scope Methods the index leaves out. */
  more: number;
  hint: string | null;
}

/**
 * Progressive disclosure for one turn (ADR-040 §D): scope chain → candidates → at most one
 * Method loaded, the rest as index lines, plus teaching/conflict guidance.
 */
export function planTurnMethods(input: {
  index: readonly MethodSummary[];
  spaces: readonly Pick<SpaceRef, "id" | "parentId">[];
  message: string;
  /** Where the turn is: active Section, conversation Space, Space named in the message. */
  spaceIds: readonly (string | null | undefined)[];
  recentId?: string | null;
}): TurnMethods {
  const parents = new Map(input.spaces.map((s) => [s.id, s.parentId]));
  const chain = scopeChain(input.spaceIds, parents);
  const selection = selectMethods(input.index, {
    message: input.message,
    chain,
    parents,
    // Only a message about the work just done keeps its Method ("hacela más corta", a
    // correction, "a partir de ahora…"); an unrelated question in the same thread doesn't.
    recentId: followsUp(input.message) ? (input.recentId ?? null) : null,
  });
  const picked = selection.selected;
  const desktop = picked && needsDesktop(picked.method) ? picked : null;
  const load = picked && !desktop ? picked : null;
  const index = indexFor({ ...selection, selected: load });
  const recent = input.recentId ? (input.index.find((m) => m.id === input.recentId) ?? null) : null;
  const active = load?.method ?? recent;
  const hints = [
    selection.ambiguous
      ? `Several Methods fit this request about equally (${selection.ambiguous.map((c) => `"${c.method.name}"`).join(", ")}): unless the user's words make it clear, ask which one to follow before working. Never merge them.`
      : null,
    desktop
      ? `The Method "${desktop.method.name}" fits, but it runs on the user's computer: say it requires the Desktop Companion, which isn't available yet, and offer what can be done here.`
      : null,
    teachingHint(
      teachingSignal(input.message),
      active ? { name: active.name, id: active.id } : null,
      input.message,
    ),
  ].filter(Boolean);
  return {
    load,
    reason: load ? selection.reason : null,
    index,
    more: Math.max(0, selection.candidates.length - index.length - (load ? 1 : 0)),
    hint: hints.join("\n") || null,
  };
}

// ── Teaching (ADR-040 §H) ────────────────────────────────────────────────────

/** "A partir de ahora…", "hacelo así siempre", "from now on…": a durable instruction. */
const DURABLE =
  /\b(a partir de ahora|de ahora en (m[aá]s|adelante)|desde ahora|(hac[eé]lo|hazlo) as[ií] siempre|siempre (hac[eé]lo|que|pon[eé]|us[aá]|empez[aá]|arranc[aá]|agreg[aá]|inclu[ií])|cada vez que|la pr[oó]xima vez|guard[aá] (esta|este|la|el) (forma|manera|procedimiento|m[eé]todo)|aprend[eé] (este|esta|c[oó]mo|a )|record[aá] (que|c[oó]mo)|from now on|going forward|every time|next time|always (do|put|use|start|include|add|begin)|do it (like this|this way) always|remember (how|this|to)|save (this|that) (way|procedure|method)|learn (this|how))\b/i;

/** "No, así no…", "en realidad…", "wrong": the user is correcting what ELISE just did. */
const CORRECTION =
  /^\s*(no[\s,.!]|nop|mal\b|eso no|as[ií] no|no as[ií]|en realidad|mejor |cambi[aá]|correg|corrig|wrong|not like that|actually|instead|that's not|no,)/i;

/** Teaching it explicitly as a Method ("guardalo como método", "save it as a method"). */
const SAVE_AS_METHOD =
  /\b(guard[aá](lo|la)? (como|en) (un |mis )?m[eé]todo|(como|un) m[eé]todo general|save (it|this) as a method)\b/i;

/**
 * Words that put an instruction above any one Space (ADR-047 §AN): "siempre", "en general",
 * "para cualquier proyecto", "sin importar el espacio"… A strong signal for General Knowledge,
 * not a rule: the conversation can still limit "siempre" to one client.
 */
const CROSS_DOMAIN =
  /\b(siempre|en general|general(es)?|para cualquier (proyecto|cliente|cosa|tema)|para todos mis (clientes|proyectos)|cada vez que|sin importar (el|en qu[eé]) espacio|aplic[aá]lo a todo|en todos (lados|mis espacios)|always|in general|for any (project|client)|for all my (clients|projects)|regardless of)\b/i;

export const crossDomainSignal = (message: string) => CROSS_DOMAIN.test(message);

const SCOPE_GUIDANCE =
  'Where to save it: the narrowest scope that represents what the user means — a Section for one subject, client or project; its Space for work across that Space; General Knowledge (space: "General Knowledge") for cross-domain ways of working (planning the day, writing for them, deciding), even inside a Space conversation. Ask only if it is genuinely ambiguous and the scope matters. Settings (timezone, language, theme, notifications) are not Methods: point to Settings. Never save something you only inferred from past conversations.';

/** Editing what was just produced: "hacela más corta", "agregá…", "make it shorter", "redo it". */
const FOLLOW_UP =
  /\b(\p{L}+[aeiáéí](la|lo|las|los|selo|sela)|otra vez|otra versi[oó]n|m[aá]s (corta|larga|breve|formal|simple|detallada)|cambi\w*|agreg\w*|sac[aá]\w*|quit[aá]\w*|correg\w*|corrig\w*|reescrib\w*|rehac\w*|ajust[aá]\w*|shorter|longer|redo|rewrite|change it|make it|add|remove|again)\b/iu;

/** A message about the work the previous turn did (so its Method still applies). */
export const followsUp = (message: string) =>
  teachingSignal(message) !== null || FOLLOW_UP.test(message);

export type TeachingSignal = "durable" | "correction" | null;

export function teachingSignal(message: string): TeachingSignal {
  if (DURABLE.test(message) || SAVE_AS_METHOD.test(message)) return "durable";
  if (CORRECTION.test(message)) return "correction";
  return null;
}

/** Turn guidance for teaching, given the Method in use (if any). */
export function teachingHint(
  signal: TeachingSignal,
  active: { name: string; id: string } | null,
  message = "",
): string | null {
  const crossDomain = crossDomainSignal(message)
    ? ' Its wording ("siempre", "en general", "cada vez que"…) reads as cross-domain: General Knowledge, unless the conversation clearly limits it to one Space or Section.'
    : "";
  if (signal === "durable")
    return active
      ? `The user is giving a durable instruction about how this work should be done. If it applies to the Method "${active.name}" (id ${active.id}), update it now with methods.update (read it with methods.get first if you haven't; pass baseVersion and a short changeSummary), then do the work the new way. Don't save it as a memory or a Space note.`
      : `The user is giving a durable instruction about how a kind of work should be done. Save it as a Method with methods.create (or methods.update if a Method for that work exists — methods.search first). ${SCOPE_GUIDANCE}${crossDomain} Don't save it as a memory or a Space note.`;
  if (signal === "correction" && active)
    return `The user is correcting work done with the Method "${active.name}" (id ${active.id}). Fix the result first. If the correction reads as a general rule for this kind of work (not a one-off detail of this case), ask in one short sentence whether to update the Method; update it only if they agree. Never turn a one-off detail into a Method.`;
  return null;
}

// ── Content (ADR-040 §B, §R) ─────────────────────────────────────────────────

export interface MethodSections {
  purpose?: string;
  whenToUse?: string;
  steps?: string[];
  checks?: string[];
  output?: string;
  examples?: string;
  mistakes?: string[];
}

const HEADINGS = {
  es: {
    purpose: "Para qué sirve",
    whenToUse: "Cuándo usarlo",
    steps: "Pasos",
    checks: "Qué revisar",
    output: "Cómo entregar el resultado",
    examples: "Ejemplos",
    mistakes: "Errores comunes",
  },
  en: {
    purpose: "What this Method is for",
    whenToUse: "When to use it",
    steps: "Steps",
    checks: "Things to check",
    output: "Output style",
    examples: "Examples",
    mistakes: "Common mistakes",
  },
} as const;

const clean = (s: string) =>
  s
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
const item = (s: string) => clean(s).replace(/^([-*•]|\d+[.)])\s+/, "");

/** The canonical readable body: plain headings and lists, only the sections that exist. */
export function composeInstructions(s: MethodSections, locale: "es" | "en"): string {
  const h = HEADINGS[locale];
  const parts: string[] = [];
  const text = (key: keyof typeof h, v?: string) =>
    v?.trim() && parts.push(`## ${h[key]}\n${clean(v)}`);
  const list = (key: keyof typeof h, v: string[] | undefined, numbered: boolean) => {
    const items = (v ?? []).map(item).filter(Boolean);
    if (items.length)
      parts.push(
        `## ${h[key]}\n${items.map((x, i) => `${numbered ? `${i + 1}.` : "-"} ${x}`).join("\n")}`,
      );
  };
  text("purpose", s.purpose);
  text("whenToUse", s.whenToUse);
  list("steps", s.steps, true);
  list("checks", s.checks, false);
  text("output", s.output);
  text("examples", s.examples);
  list("mistakes", s.mistakes, false);
  return parts.join("\n\n");
}

export function normalizeHints(hints: readonly string[] | undefined): string[] {
  return [
    ...new Set(
      (hints ?? [])
        .map((h) => h.trim().toLowerCase().slice(0, METHOD_LIMITS.hint))
        .filter((h) => h.length >= 2),
    ),
  ].slice(0, METHOD_LIMITS.hints);
}

/**
 * What ELISE writes must be a reusable procedure: not a transcript, not a log of one case, not
 * a wall of text. Returns the problems (empty = fine).
 */
export function qualityIssues(instructions: string): string[] {
  const issues: string[] = [];
  if (instructions.length > METHOD_LIMITS.generatedInstructions)
    issues.push(
      `too long (${instructions.length} characters; keep it under ${METHOD_LIMITS.generatedInstructions}: the procedure, not every detail)`,
    );
  const turns = instructions.match(/^\s*(user|usuario|elise|assistant|asistente|yo|vos)\s*:/gim);
  if ((turns?.length ?? 0) >= 2)
    issues.push("reads like a conversation transcript (write the procedure, not the dialogue)");
  const dates = instructions.match(/\b(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4})\b/g);
  if ((dates?.length ?? 0) >= 3)
    issues.push("has dated, one-off details (keep only what applies every time)");
  if (instructions.trim().length < 20) issues.push("too short to be a procedure");
  return issues;
}

/** Validates and trims a Method's fields; ELISE-written content also passes qualityIssues. */
export function normalizeMethod(input: NewMethod, opts: { generated: boolean }): NewMethod {
  const name = input.name.trim().replace(/\s+/g, " ");
  const description = input.description.trim().replace(/\s+/g, " ");
  const instructions = clean(input.instructions);
  if (!name || name.length > METHOD_LIMITS.name)
    throw new AppError("VALIDATION_ERROR", "A Method needs a short name", { recovery: "review" });
  if (!description || description.length > METHOD_LIMITS.description)
    throw new AppError(
      "VALIDATION_ERROR",
      `Describe what the Method is for in one line (up to ${METHOD_LIMITS.description} characters)`,
      { recovery: "review" },
    );
  if (!instructions || instructions.length > METHOD_LIMITS.instructions)
    throw new AppError("VALIDATION_ERROR", "The instructions are empty or too long", {
      recovery: "review",
    });
  if (opts.generated) {
    const issues = qualityIssues(instructions);
    if (issues.length)
      throw new AppError(
        "VALIDATION_ERROR",
        `Rewrite the Method as a reusable procedure: ${issues.join("; ")}.`,
        { recovery: "review" },
      );
  }
  return {
    ...input,
    name,
    description,
    instructions,
    hints: normalizeHints(input.hints),
    ...(input.platforms
      ? { platforms: [...new Set(input.platforms)].filter((p) => METHOD_PLATFORMS.includes(p)) }
      : {}),
  };
}

/** A Method that needs a runtime ELISE doesn't have yet (the Desktop Companion, ADR-040 §S). */
export const needsDesktop = (m: Pick<MethodSummary, "platforms">) =>
  !m.platforms.includes("web") && m.platforms.includes("desktop");

/** Same name in the same scope means the same Method (update it, don't duplicate it). */
export const nameKey = (name: string) => tokens(name).join(" ") || name.trim().toLowerCase();

/** Text that reads like instructions (numbered steps, procedure headings): offer "Use as Method". */
export function looksProcedural(text: string): boolean {
  if (text.length < 80 || text.length > 60_000) return false;
  const steps = text.match(/^\s*(\d+[.)]|[-*•])\s+\S/gm)?.length ?? 0;
  const headings =
    /^\s*#{0,3}\s*(pasos|procedimiento|cuándo usar|cuando usar|instrucciones|steps|procedure|when to use|instructions|checklist)\b/im.test(
      text,
    );
  const imperative =
    /^\s*(\d+[.)]|[-*•])\s+(revis|verific|prepar|envi|incluí|inclu|us[aá]|agreg|cheque|define|check|review|send|include|use|add|write|escrib|calcul|explic|explain)/gim;
  return (headings && steps >= 2) || (text.match(imperative)?.length ?? 0) >= 3;
}

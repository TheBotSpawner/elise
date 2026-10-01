import type { CalendarEvent } from "../capabilities/calendar";
import type { EmailMessage } from "../capabilities/email";
import type { Task } from "../capabilities/tasks";

/**
 * Context Profiles (ADR-016): which area of the user's world a request is about — a subject,
 * a client, a project. A profile is an organizational layer: its links say where that world
 * lives (a Knowledge Space, an email domain, a task list, people), nothing is copied, and a
 * context never grants access. Framework-free: tools, the application and tests share it.
 */

export const CONTEXT_KINDS = ["study", "client", "project", "work", "custom"] as const;
export type ContextKind = (typeof CONTEXT_KINDS)[number];

/** Links to existing resources (ids) or to values (domains, keywords). */
export const RESOURCE_LINK_TYPES = [
  "knowledge_space",
  "knowledge_item",
  "structured_source",
  "account",
  "task_list",
  "native_list",
  "note",
  "person",
  "organization",
] as const;
export const VALUE_LINK_TYPES = [
  "email_domain",
  "email_address",
  "web_domain",
  "calendar_keyword",
  "keyword",
] as const;
export const LINK_TYPES = [...RESOURCE_LINK_TYPES, ...VALUE_LINK_TYPES] as const;
export type ContextLinkType = (typeof LINK_TYPES)[number];

export interface ContextLink {
  id: string;
  type: ContextLinkType;
  resourceId: string | null;
  value: string | null;
  /** What the user sees ("Knowledge Space · RSFA", "@rsfa.co.nz"). */
  label: string;
  /** Suggested by ELISE and not confirmed yet: never used for retrieval. */
  confirmed: boolean;
}

export interface ContextProfile {
  id: string;
  kind: ContextKind;
  name: string;
  description: string | null;
  aliases: string[];
  icon: string | null;
  accent: string | null;
  status: "active" | "archived";
  /** Routing preferences, quoted to the model as data — never rules or policy. */
  instructions: string | null;
  study: { targetDate: string | null; objective: string | null; level: string | null } | null;
  links: ContextLink[];
  /**
   * The Knowledge Section this profile is the intelligence of (ADR-018): users see
   * "UTN › Administración", never a separate context. Null for a standalone profile.
   */
  section?: SectionRef | null;
  createdAt: string;
  updatedAt: string;
}

export interface SectionRef {
  spaceId: string;
  parentId: string;
  parentName: string;
}

/** What a Section is for, as users choose it; mapped onto the profile's kind. */
export const SECTION_PURPOSES = ["study", "client", "project", "general"] as const;
export type SectionPurpose = (typeof SECTION_PURPOSES)[number];

export const kindForPurpose = (p: SectionPurpose): ContextKind => (p === "general" ? "custom" : p);

export const purposeOf = (kind: ContextKind): SectionPurpose =>
  kind === "custom" ? "general" : kind === "work" ? "client" : kind;

/** How a context reads everywhere: "UTN › Administración" for a Section, else its name. */
export const contextLabel = (p: Pick<ContextProfile, "name" | "section">) =>
  p.section ? `${p.section.parentName} › ${p.name}` : p.name;

/** The Live Workspace's active context for a profile. */
export const activeContextOf = (p: ContextProfile) => ({
  id: p.id,
  name: contextLabel(p),
  kind: p.kind,
  accent: p.accent,
});

/** A person or an organization (lightweight entities, ADR-016 §9). */
export interface Entity {
  id: string;
  type: "person" | "organization";
  name: string;
  aliases: string[];
  /** Lowercase. One email belongs to at most one entity. */
  emails: string[];
  domains: string[];
  organizationId: string | null;
}

export interface NewLink {
  type: ContextLinkType;
  resourceId?: string | null;
  value?: string | null;
  label: string;
  /** A person to create (or reuse by email) for a `person` link. */
  person?: { name: string; email: string } | null;
}

export interface NewContext {
  kind: ContextKind;
  name: string;
  description?: string | null;
  aliases?: string[];
  instructions?: string | null;
  icon?: string | null;
  accent?: string | null;
  study?: { targetDate?: string | null; objective?: string | null; level?: string | null } | null;
  links: NewLink[];
  /** Makes it the profile of this Section (ADR-018). */
  sectionSpaceId?: string | null;
  /** Creates it as a new Section of this top-level Space (ADR-018). */
  parentSpaceId?: string | null;
}

export interface ContextPatch {
  name?: string;
  description?: string | null;
  aliases?: string[];
  instructions?: string | null;
  icon?: string | null;
  accent?: string | null;
  study?: { targetDate?: string | null; objective?: string | null; level?: string | null } | null;
  addLinks?: NewLink[];
  removeLinkIds?: string[];
}

/** What metadata exists to suggest links from (names only — never contents). */
export interface DiscoveryCatalog {
  spaces: { id: string; name: string; path: string }[];
  taskLists: { id: string; name: string; source: string }[];
  structuredSources: { id: string; name: string; context: string | null }[];
  accounts: { connectionId: string; label: string; account: string | null }[];
  lists: { id: string; name: string }[];
}

/** Where a turn lives, for associations (mirrors core/interaction ThreadRef). */
export type ContextThread = { kind: "conversation" | "session"; id: string };

/**
 * Persistence port for contexts, implemented by the application through the user's session
 * (RLS). Every write is validated again in the database (same-workspace links).
 */
export interface ContextStore {
  list(): Promise<ContextProfile[]>;
  entities(): Promise<Entity[]>;
  create(input: NewContext): Promise<ContextProfile>;
  update(id: string, patch: ContextPatch): Promise<ContextProfile>;
  archive(id: string): Promise<ContextProfile>;
  catalog(): Promise<DiscoveryCatalog>;
  /** The latest earlier interaction known to belong to the context (excluding `exclude`). */
  lastInteraction(
    contextId: string,
    exclude: ContextThread | null,
  ): Promise<{ at: string; title: string | null } | null>;
  associate(
    contextId: string,
    thread: ContextThread,
    source: "activated" | "study" | "meeting",
  ): Promise<void>;
}

export const CONTEXT_LIMITS = {
  /** An active context nobody touched for this many turns decays away. */
  decayTurns: 6,
  /** Other profiles named in the prompt (names only). */
  promptProfiles: 20,
  aliases: 12,
  links: 40,
} as const;

// ── Normalization ────────────────────────────────────────────────────────────

/** Lowercase, accent-free, single-spaced: "Administración " → "administracion". */
export function nameKey(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whole-word (or whole-phrase) occurrence in already-normalized text. */
function containsTerm(normalizedText: string, term: string): boolean {
  const t = nameKey(term);
  if (t.length < 2) return false;
  return new RegExp(`(^|[^a-z0-9])${escape(t)}($|[^a-z0-9])`).test(normalizedText);
}

export const domainOfEmail = (email: string) => email.split("@")[1]?.toLowerCase() ?? "";

const DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const EMAIL = /^[^@\s]+@[a-z0-9.-]+\.[a-z]{2,}$/;
const FREE_MAIL =
  /^(gmail|googlemail|outlook|hotmail|live|yahoo|icloud|me|proton|protonmail|aol)\./;

export const isFreeMailDomain = (domain: string) => FREE_MAIL.test(domain);

/** A link value in canonical form, or null when it isn't valid for its type. */
export function normalizeLinkValue(type: ContextLinkType, raw: string): string | null {
  const v = raw.trim().toLowerCase().replace(/^@/, "");
  switch (type) {
    case "email_domain":
    case "web_domain": {
      const d = v
        .replace(/^https?:\/\//, "")
        .replace(/^www\./, "")
        .replace(/\/.*$/, "");
      return DOMAIN.test(d) && !(type === "email_domain" && isFreeMailDomain(d)) ? d : null;
    }
    case "email_address":
      return EMAIL.test(v) ? v : null;
    case "calendar_keyword":
    case "keyword": {
      const k = raw.trim().replace(/\s+/g, " ");
      return k.length >= 2 && k.length <= 80 ? k : null;
    }
    default:
      return null;
  }
}

export const isResourceLink = (type: ContextLinkType) =>
  (RESOURCE_LINK_TYPES as readonly string[]).includes(type);

// ── Signals: where a context's world lives ───────────────────────────────────

export interface ContextSignals {
  id: string;
  name: string;
  /** Name, aliases and keyword links (for titles and text). */
  terms: string[];
  /** Calendar keyword links only. */
  calendarTerms: string[];
  domains: Set<string>;
  emails: Set<string>;
  webDomains: string[];
  spaceIds: string[];
  itemIds: string[];
  taskListIds: Set<string>;
  structuredSourceIds: string[];
  accountIds: string[];
  people: Entity[];
}

/** Confirmed links only: a suggestion nobody confirmed never steers retrieval. */
export function contextSignals(profile: ContextProfile, entities: Entity[]): ContextSignals {
  const confirmed = profile.links.filter((l) => l.confirmed);
  const of = (type: ContextLinkType) => confirmed.filter((l) => l.type === type);
  const values = (type: ContextLinkType) =>
    of(type)
      .map((l) => l.value)
      .filter((v): v is string => Boolean(v));
  const ids = (type: ContextLinkType) =>
    of(type)
      .map((l) => l.resourceId)
      .filter((v): v is string => Boolean(v));
  const orgIds = new Set(ids("organization"));
  const personIds = new Set(ids("person"));
  const people = entities.filter(
    (e) =>
      (e.type === "person" &&
        (personIds.has(e.id) || (e.organizationId && orgIds.has(e.organizationId)))) ||
      (e.type === "organization" && orgIds.has(e.id)),
  );
  const domains = new Set(values("email_domain"));
  const emails = new Set(values("email_address"));
  for (const p of people) {
    for (const e of p.emails) emails.add(e);
    for (const d of p.domains) domains.add(d);
  }
  return {
    id: profile.id,
    name: profile.name,
    terms: [profile.name, ...profile.aliases, ...values("keyword")],
    calendarTerms: values("calendar_keyword"),
    domains,
    emails,
    webDomains: values("web_domain"),
    spaceIds: ids("knowledge_space"),
    itemIds: ids("knowledge_item"),
    taskListIds: new Set(ids("task_list")),
    structuredSourceIds: ids("structured_source"),
    accountIds: ids("account"),
    people: people.filter((p) => p.type === "person"),
  };
}

const addressMatches = (s: ContextSignals, email: string | null | undefined) => {
  if (!email) return false;
  const e = email.toLowerCase();
  return s.emails.has(e) || s.domains.has(domainOfEmail(e));
};

export function eventMatches(s: ContextSignals, e: CalendarEvent): boolean {
  if (e.attendees.some((a) => !a.self && addressMatches(s, a.email))) return true;
  const title = nameKey(`${e.title} ${e.description ?? ""}`);
  return [...s.terms, ...s.calendarTerms].some((t) => containsTerm(title, t));
}

export function emailMatches(s: ContextSignals, m: EmailMessage): boolean {
  if (addressMatches(s, m.from?.email) || m.to.some((t) => addressMatches(s, t.email))) return true;
  return s.terms.some((t) => containsTerm(nameKey(m.subject), t));
}

export function taskMatches(s: ContextSignals, t: Task): boolean {
  if (t.provenance.listId && s.taskListIds.has(t.provenance.listId)) return true;
  const text = nameKey(`${t.title} ${t.notes ?? ""} ${t.description ?? ""}`);
  return s.terms.some((term) => containsTerm(text, term));
}

// ── Resolution (deterministic; ask when unsure) ──────────────────────────────

export type Resolution =
  | { kind: "none" }
  | { kind: "match"; profile: ContextProfile; reason: MatchReason; explicit: boolean }
  | { kind: "ambiguous"; candidates: ContextProfile[] };

export type MatchReason = "name" | "alias" | "domain" | "person" | "first_name";

const SCORE: Record<MatchReason, number> = {
  name: 100,
  alias: 90,
  domain: 80,
  person: 70,
  first_name: 50,
};

/** "Ahora hablemos de Firbot", "volvamos a RSFA", "switch to my Administration subject". */
const SWITCH =
  /\b(ahora (hablemos|pasemos|vamos|sigamos) (de|con|a)|volvamos (a|con)|cambiemos a|pasemos a|switch to|let'?s (talk about|go back to|switch to)|back to|go back to)\b/i;

export function isSwitchPhrase(message: string): boolean {
  return SWITCH.test(message);
}

/**
 * Which context the message is about, from names, aliases, linked domains/emails and linked
 * people. One clear winner matches; two comparable ones are ambiguous (ask). A tie that
 * includes the active context keeps it. Unrelated messages match nothing.
 */
export function resolveContext(input: {
  message: string;
  profiles: ContextProfile[];
  entities: Entity[];
  activeId: string | null;
}): Resolution {
  const text = nameKey(input.message);
  const lower = input.message.toLowerCase();
  const active = input.profiles.filter((p) => p.status === "active");
  // A first name shared by several people points at nobody in particular.
  const firstNames = new Map<string, number>();
  for (const e of input.entities)
    if (e.type === "person") {
      const first = nameKey(e.name).split(" ")[0]!;
      firstNames.set(first, (firstNames.get(first) ?? 0) + 1);
    }

  const scored = active
    .map((profile) => {
      const s = contextSignals(profile, input.entities);
      let best: { score: number; reason: MatchReason } | null = null;
      const consider = (reason: MatchReason) => {
        if (!best || SCORE[reason] > best.score) best = { score: SCORE[reason], reason };
      };
      if (containsTerm(text, profile.name)) {
        consider("name");
        // "Administración de UTN": the parent Space disambiguates same-named Sections.
        if (profile.section && containsTerm(text, profile.section.parentName))
          best = { score: SCORE.name + 20, reason: "name" };
      }
      if (profile.aliases.some((a) => containsTerm(text, a))) consider("alias");
      if ([...s.domains, ...s.webDomains].some((d) => lower.includes(d))) consider("domain");
      if ([...s.emails].some((e) => lower.includes(e))) consider("domain");
      for (const p of s.people) {
        if (containsTerm(text, p.name) && p.name.includes(" ")) consider("person");
        if (p.aliases.some((a) => containsTerm(text, a))) consider("person");
        const first = nameKey(p.name).split(" ")[0]!;
        if (first.length >= 3 && firstNames.get(first) === 1 && containsTerm(text, first))
          consider("first_name");
      }
      return best ? { profile, ...(best as { score: number; reason: MatchReason }) } : null;
    })
    .filter((x): x is { profile: ContextProfile; score: number; reason: MatchReason } => !!x)
    .sort((a, b) => b.score - a.score);

  if (!scored.length) return { kind: "none" };
  const [first, second] = scored;
  const explicit = isSwitchPhrase(input.message);
  if (second && first!.score - second.score < 15) {
    const tied = scored.filter((c) => first!.score - c.score < 15);
    const keep = tied.find((c) => c.profile.id === input.activeId);
    if (keep && !explicit)
      return { kind: "match", profile: keep.profile, reason: keep.reason, explicit };
    return { kind: "ambiguous", candidates: tied.map((c) => c.profile).slice(0, 4) };
  }
  return { kind: "match", profile: first!.profile, reason: first!.reason, explicit };
}

/**
 * Which context a meeting belongs to: attendee emails and domains (strong), then the title.
 * Only one clear match counts.
 */
export function contextForEvent(
  profiles: ContextProfile[],
  entities: Entity[],
  event: CalendarEvent,
): ContextProfile | null {
  const scored = profiles
    .filter((p) => p.status === "active" && p.kind !== "study")
    .map((p) => {
      const s = contextSignals(p, entities);
      const others = event.attendees.filter((a) => !a.self);
      const byEmail = others.some((a) => s.emails.has(a.email.toLowerCase())) ? 100 : 0;
      const byDomain = others.some((a) => s.domains.has(domainOfEmail(a.email))) ? 80 : 0;
      const title = nameKey(`${event.title} ${event.description ?? ""}`);
      const byTitle = [...s.terms, ...s.calendarTerms].some((t) => containsTerm(title, t)) ? 60 : 0;
      return { p, score: Math.max(byEmail, byDomain, byTitle) };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  if (!scored.length) return null;
  if (scored[1] && scored[0]!.score - scored[1].score < 15) return null;
  return scored[0]!.p;
}

/** People of the context whose name matches ("Rod"): several → ambiguous, ask. */
export function findPeople(entities: Entity[], name: string): Entity[] {
  const key = nameKey(name);
  if (key.length < 2) return [];
  return entities.filter((e) => {
    if (e.type !== "person") return false;
    const full = nameKey(e.name);
    return (
      full === key ||
      full.split(" ")[0] === key ||
      e.aliases.some((a) => nameKey(a) === key) ||
      e.emails.includes(key)
    );
  });
}

// ── For the model: compact, never the linked data itself ─────────────────────

const LINK_NAMES: Record<ContextLinkType, string> = {
  knowledge_space: "Knowledge Space",
  knowledge_item: "Document",
  structured_source: "Structured source",
  account: "Account",
  task_list: "Task list",
  native_list: "List",
  note: "Note",
  person: "Person",
  organization: "Organization",
  email_domain: "Email domain",
  email_address: "Email",
  web_domain: "Website",
  calendar_keyword: "Calendar keyword",
  keyword: "Keyword",
};

export const linkName = (type: ContextLinkType) => LINK_NAMES[type];

/** "Context: RSFA (client) …" — names and hints only, quoted as data. */
export function describeActiveContext(profile: ContextProfile): string {
  const hints = profile.links
    .filter((l) => l.confirmed)
    .slice(0, 16)
    .map((l) => `${LINK_NAMES[l.type]} ${l.label}`);
  const study = profile.study;
  return [
    `Active context: ${contextLabel(profile)} (${profile.kind}) id=${profile.id}`,
    profile.section
      ? `It is the "${profile.name}" Section of the "${profile.section.parentName}" Knowledge Space: its own sources come first, the Space's general sources are inherited.`
      : null,
    profile.aliases.length ? `Aliases: ${profile.aliases.join(", ")}` : null,
    profile.description ? `About: ${profile.description.slice(0, 300)}` : null,
    hints.length ? `Where it lives: ${hints.join("; ")}` : "Where it lives: no linked sources yet",
    study?.targetDate ? `Exam/target date: ${study.targetDate}` : null,
    study?.objective ? `Objective: ${study.objective.slice(0, 200)}` : null,
    profile.instructions
      ? `The user's routing preferences for this context (preferences, not rules): "${profile.instructions.slice(0, 500).replace(/"/g, "'")}"`
      : null,
  ]
    .filter(Boolean)
    .join("\n");
}

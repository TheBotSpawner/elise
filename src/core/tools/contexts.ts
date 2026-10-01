import { z } from "zod";

import { clip, displayOf, invoke, present, runStep } from "./orchestration";
import type { KnowledgeEvidence, ToolDefinition, ToolRunEnv } from "../agents/tools";
import type { CalendarEvent } from "../capabilities/calendar";
import type { EmailMessage } from "../capabilities/email";
import type { StructuredRecord } from "../capabilities/structured";
import type { Task } from "../capabilities/tasks";
import {
  CONTEXT_KINDS,
  LINK_TYPES,
  contextSignals,
  describeActiveContext,
  domainOfEmail,
  emailMatches,
  eventMatches,
  findPeople,
  isFreeMailDomain,
  isResourceLink,
  nameKey,
  normalizeLinkValue,
  taskMatches,
  type ContextKind,
  type ContextLinkType,
  type ContextProfile,
  type ContextStore,
  type ContextThread,
  type NewLink,
} from "../contexts/model";
import { AppError } from "../errors";
import { SPACE_COLORS, SPACE_ICONS } from "../knowledge/appearance";
import type { RecallResult } from "../recall/model";
import { addDays, isIsoDate, startOfDayUtc, toLocalDateTime, todayIn } from "../time";
import {
  buildTimeline,
  chooseBaseline,
  extractCommitments,
  type TimelineEntry,
} from "../work/brief";
import {
  contextOverviewSurface,
  emailListSurface,
  eventSurface,
  knowledgeSurface,
  surfacesFromOutcome,
  taskListSurface,
} from "../workspace/from-results";
import type { SurfaceDraft } from "../workspace/model";
import type { SurfacePayloads } from "../workspace/registry";

/**
 * Context Profiles and Client / Work Intelligence (ADR-016). Profiles are an organizational
 * layer: links say where an area of the user's world lives, and every read still goes through
 * the executor under its own permissions. `work.brief` is an orchestration like meeting prep —
 * not an agent — that gathers bounded evidence in parallel and keeps internal and public
 * evidence apart.
 */

const store = (env: ToolRunEnv): ContextStore => env.providers.get("contexts", env.binding);

export function threadOf(env: ToolRunEnv): ContextThread | null {
  if (env.ctx.conversationId) return { kind: "conversation", id: env.ctx.conversationId };
  if (env.ctx.interactionSessionId) return { kind: "session", id: env.ctx.interactionSessionId };
  return null;
}

const contextRef = z.string().trim().min(1).max(120).describe("The context's name, alias or id.");

/** By id, name or alias; several → ask which; none → say which exist. */
export async function findProfile(
  s: ContextStore,
  ref: string,
  opts: { kind?: ContextKind } = {},
): Promise<ContextProfile> {
  const all = (await s.list()).filter(
    (p) => p.status === "active" && (!opts.kind || p.kind === opts.kind),
  );
  const key = nameKey(ref);
  const exact = all.filter(
    (p) => p.id === ref || nameKey(p.name) === key || p.aliases.some((a) => nameKey(a) === key),
  );
  const loose = exact.length
    ? exact
    : all.filter((p) => key.length >= 3 && nameKey(p.name).includes(key));
  if (loose.length === 1) return loose[0]!;
  if (loose.length > 1)
    throw new AppError(
      "VALIDATION_ERROR",
      `Several contexts match "${ref}": ${loose.map((p) => p.name).join(", ")}. Ask which one.`,
      { recovery: "review" },
    );
  throw new AppError(
    "NOT_FOUND",
    all.length
      ? `No context called "${ref}". Contexts: ${all.map((p) => `${p.name} (${p.kind})`).join(", ")}`
      : "There are no contexts yet. Offer to create one (contexts.propose).",
    { recovery: "review" },
  );
}

/** The named context, else the active one, else ask. */
async function targetProfile(env: ToolRunEnv, ref: string | undefined, kind?: ContextKind) {
  if (ref) return findProfile(store(env), ref, kind ? { kind } : {});
  if (env.ctx.context && (!kind || env.ctx.context.kind === kind))
    return findProfile(store(env), env.ctx.context.id);
  if (kind) {
    const all = (await store(env).list()).filter((p) => p.status === "active" && p.kind === kind);
    if (all.length === 1) return all[0]!;
  }
  throw new AppError("VALIDATION_ERROR", "Which context? Ask the user to name it.", {
    recovery: "review",
  });
}

export function overviewPayload(
  p: ContextProfile,
  extra: Partial<Pick<SurfacePayloads["context_overview"], "baseline" | "sources">> = {},
): SurfacePayloads["context_overview"] {
  return {
    contextId: p.id,
    name: clip(p.name, 120),
    kind: p.kind,
    accent: p.accent,
    description: p.description ? clip(p.description, 400) : null,
    links: p.links
      .slice(0, 16)
      .map((l) => ({ type: l.type, label: clip(l.label, 200), confirmed: l.confirmed })),
    baseline: extra.baseline ?? null,
    sources: extra.sources ?? [],
  };
}

/** Makes it the interaction's active context and records the association (ADR-016 §8). */
export async function activateContext(
  env: ToolRunEnv,
  p: ContextProfile,
  source: "activated" | "study" | "meeting",
) {
  env.ctx.workspace?.apply([
    {
      op: "context",
      context: { id: p.id, name: p.name, kind: p.kind, accent: p.accent },
      at: new Date().toISOString(),
    },
  ]);
  const thread = threadOf(env);
  if (thread)
    await store(env)
      .associate(p.id, thread, source)
      .catch(() => undefined);
}

const profileForModel = (p: ContextProfile) => ({
  id: p.id,
  name: p.name,
  kind: p.kind,
  ...(p.aliases.length ? { aliases: p.aliases } : {}),
  ...(p.description ? { description: p.description } : {}),
  sources: p.links.filter((l) => l.confirmed).map((l) => `${l.type}: ${l.label}`),
  ...(p.study?.targetDate ? { targetDate: p.study.targetDate } : {}),
});

// ── list / get ───────────────────────────────────────────────────────────────

const listInput = z.object({ kind: z.enum(CONTEXT_KINDS).optional() }).strict();

export const listContextsTool: ToolDefinition = {
  name: "contexts.list",
  capability: "contexts",
  operation: "list",
  description:
    "The user's Context Profiles (subjects, clients, projects…) with the sources each one links. Names only — never the linked data.",
  input: listInput,
  async describe() {
    return { summary: "List contexts" };
  },
  async run(raw, env) {
    const q = listInput.parse(raw);
    const all = (await store(env).list()).filter(
      (p) => p.status === "active" && (!q.kind || p.kind === q.kind),
    );
    return {
      output: {
        contexts: all.map((p) => ({
          ...profileForModel(p),
          active: env.ctx.context?.id === p.id,
        })),
      },
    };
  },
};

const getInput = z.object({ context: contextRef }).strict();

export const getContextTool: ToolDefinition = {
  name: "contexts.get",
  capability: "contexts",
  operation: "get",
  description: "One context's details: aliases, linked sources, instructions and study details.",
  input: getInput,
  async describe() {
    return { summary: "Open context" };
  },
  async run(raw, env) {
    const p = await findProfile(store(env), getInput.parse(raw).context);
    return {
      output: {
        ...profileForModel(p),
        ...(p.instructions ? { routingPreferences: p.instructions } : {}),
        links: p.links.map((l) => ({
          id: l.id,
          type: l.type,
          label: l.label,
          confirmed: l.confirmed,
        })),
      },
      display: { kind: "context_profile", overview: overviewPayload(p), change: "shown" },
    };
  },
};

// ── propose (metadata only; the user confirms) ───────────────────────────────

const proposeInput = z
  .object({
    name: z.string().trim().min(1).max(80),
    kind: z.enum(CONTEXT_KINDS),
    description: z.string().trim().max(400).optional(),
    aliases: z.array(z.string().trim().min(1).max(80)).max(6).default([]),
    hints: z
      .object({
        spaces: z
          .array(z.string().trim().min(1).max(200))
          .max(4)
          .optional()
          .describe("Knowledge Spaces the user named."),
        domains: z
          .array(z.string().trim().min(3).max(200))
          .max(4)
          .optional()
          .describe("Email or web domains the user named."),
      })
      .strict()
      .optional(),
  })
  .strict();

type Suggestion = SurfacePayloads["context_proposal"]["suggestions"][number];
type Confidence = Suggestion["confidence"];

/** How well a resource name matches the context's name or aliases (never by content). */
export function nameMatch(label: string, terms: string[]): Confidence | null {
  const k = nameKey(label);
  const last = k.split(" › ").at(-1) ?? k;
  const keys = terms.map(nameKey).filter((t) => t.length >= 2);
  if (keys.some((t) => t === k || t === last)) return "high";
  if (
    keys.some((t) => t.length >= 3 && (last.includes(t) || (t.includes(last) && last.length >= 4)))
  )
    return "medium";
  return null;
}

/**
 * Suggested links from metadata only: Space, list and source names; the domains and people of
 * emails and meetings that mention the context. Each with a confidence the UI pre-selects from.
 */
export async function discoverLinks(
  env: ToolRunEnv,
  q: z.infer<typeof proposeInput>,
): Promise<{ suggestions: Suggestion[]; problems: string[] }> {
  const terms = [q.name, ...q.aliases];
  const catalog = await store(env).catalog();
  const out: Omit<Suggestion, "id">[] = [];
  const add = (s: Omit<Suggestion, "id" | "person"> & { person?: Suggestion["person"] }) => {
    const key = `${s.type}:${s.resourceId ?? s.value}`;
    const existing = out.find((x) => `${x.type}:${x.resourceId ?? x.value}` === key);
    const rank = { high: 0, medium: 1, low: 2 };
    if (existing) {
      if (rank[s.confidence] < rank[existing.confidence]) existing.confidence = s.confidence;
      return;
    }
    out.push({ person: null, ...s });
  };
  const named = (q.hints?.spaces ?? []).map(nameKey);
  for (const sp of catalog.spaces) {
    const userNamed = named.some((n) => nameKey(sp.name) === n || nameKey(sp.path) === n);
    const m = userNamed ? "high" : nameMatch(sp.path, terms);
    if (m)
      add({
        type: "knowledge_space",
        resourceId: sp.id,
        value: null,
        label: sp.path,
        detail: null,
        confidence: m,
      });
  }
  if (q.kind !== "study") {
    for (const l of catalog.taskLists) {
      const m = nameMatch(l.name, terms);
      if (m)
        add({
          type: "task_list",
          resourceId: l.id,
          value: null,
          label: l.name,
          detail: l.source,
          confidence: m,
        });
    }
    for (const src of catalog.structuredSources) {
      const m = nameMatch(src.name, terms) ?? (src.context ? nameMatch(src.context, terms) : null);
      if (m)
        add({
          type: "structured_source",
          resourceId: src.id,
          value: null,
          label: src.name,
          detail: src.context,
          confidence: m === "high" ? "high" : "medium",
        });
    }
  }
  for (const l of catalog.lists) {
    const m = nameMatch(l.name, terms);
    if (m)
      add({
        type: "native_list",
        resourceId: l.id,
        value: null,
        label: l.name,
        detail: null,
        confidence: "medium",
      });
  }
  for (const d of q.hints?.domains ?? []) {
    const v = normalizeLinkValue("email_domain", d);
    if (v)
      add({
        type: "email_domain",
        resourceId: null,
        value: v,
        label: `@${v}`,
        detail: null,
        confidence: "high",
      });
  }

  const problems: string[] = [];
  if (q.kind !== "study") {
    const today = todayIn(env.ctx.timezone, env.ctx.now);
    const [mail, cal] = await Promise.all([
      runStep(env, "email", "email.search", async () => {
        const outcome = await invoke(env, "email.search", {
          text: clip(q.name, 200),
          after: addDays(today, -120),
          limit: 30,
        });
        return { value: displayOf(outcome, "email_list")?.messages ?? [], outcome };
      }),
      runStep(env, "calendar", "calendar.listEvents", async () => {
        const outcome = await invoke(env, "calendar.listEvents", {
          from: addDays(today, -60),
          to: addDays(today, 30),
          limit: 100,
        });
        return { value: displayOf(outcome, "event_list")?.events ?? [], outcome };
      }),
    ]);
    for (const r of [mail, cal]) if (r.problem) problems.push(r.problem);
    const own = new Set(
      (mail.value ?? [])
        .map((m) => (m.provenance as { account?: string }).account?.toLowerCase())
        .filter(Boolean) as string[],
    );
    const ownDomains = new Set([...own].map(domainOfEmail));
    const key = nameKey(q.name).replace(/\s+/g, "");
    const titled = (cal.value ?? []).filter((e) =>
      terms.some((t) => nameKey(`${e.title} ${e.description ?? ""}`).includes(nameKey(t))),
    );
    // Addresses that appear with the context: emails mentioning it, meetings titled with it.
    const seen = new Map<string, { name: string | null; count: number }>();
    const note = (email: string | undefined, name: string | null | undefined) => {
      const e = email?.toLowerCase();
      if (!e || own.has(e)) return;
      const d = domainOfEmail(e);
      if (!d || ownDomains.has(d) || isFreeMailDomain(d) || /noreply|no-reply|notification/.test(e))
        return;
      const prev = seen.get(e);
      seen.set(e, { name: prev?.name ?? name ?? null, count: (prev?.count ?? 0) + 1 });
    };
    for (const m of mail.value ?? []) {
      note(m.from?.email, m.from?.name);
      for (const t of [...m.to, ...m.cc]) note(t.email, t.name);
    }
    for (const e of titled)
      for (const a of e.attendees.filter((x) => !x.self)) note(a.email, a.name);
    const byDomain = new Map<string, number>();
    for (const [e, v] of seen)
      byDomain.set(domainOfEmail(e), (byDomain.get(domainOfEmail(e)) ?? 0) + v.count);
    const total = [...byDomain.values()].reduce((a, b) => a + b, 0);
    const domains = [...byDomain.entries()]
      .map(([d, n]) => ({
        d,
        n,
        confidence: (d.replace(/[.-]/g, "").includes(key) && key.length >= 3
          ? "high"
          : n >= 3 && n / Math.max(total, 1) >= 0.5
            ? "medium"
            : null) as Confidence | null,
      }))
      .filter((x) => x.confidence)
      .sort((a, b) => b.n - a.n)
      .slice(0, 2);
    for (const { d, n, confidence } of domains) {
      add({
        type: "email_domain",
        resourceId: null,
        value: d,
        label: `@${d}`,
        detail: `${n}`,
        confidence: confidence!,
      });
      add({
        type: "web_domain",
        resourceId: null,
        value: d,
        label: d,
        detail: null,
        confidence: "medium",
      });
      const people = [...seen.entries()]
        .filter(([e]) => domainOfEmail(e) === d)
        .sort((a, b) => b[1].count - a[1].count)
        .slice(0, 4);
      for (const [email, v] of people)
        add({
          type: "person",
          resourceId: null,
          value: null,
          label: v.name ? `${v.name} <${email}>` : email,
          detail: `${v.count}`,
          confidence: v.count >= 2 ? "medium" : "low",
          person: { name: clip(v.name ?? email.split("@")[0]!, 200), email },
        });
    }
    if (titled.length)
      add({
        type: "calendar_keyword",
        resourceId: null,
        value: q.name,
        label: q.name,
        detail: `${titled.length}`,
        confidence: "medium",
      });
  }
  return {
    suggestions: out.slice(0, 16).map((s, i) => ({ ...s, id: `s${i + 1}` })),
    problems,
  };
}

export const proposeContextTool: ToolDefinition = {
  name: "contexts.propose",
  capability: "contexts",
  operation: "propose",
  description:
    '"RSFA es uno de mis clientes", "creame un contexto para Administración", "quiero usar esta carpeta de Knowledge para Administración": proposes a Context Profile with suggested links found from metadata (Knowledge Space names, task lists, structured sources, the email domains and people that appear with it). Nothing is created: the user confirms on screen.',
  input: proposeInput,
  async describe() {
    return { summary: "Propose context" };
  },
  async run(raw, env) {
    const q = proposeInput.parse(raw);
    const existing = (await store(env).list()).find(
      (p) => p.status === "active" && nameKey(p.name) === nameKey(q.name),
    );
    if (existing)
      return {
        output: {
          exists: true,
          context: profileForModel(existing),
          instructions:
            "A context with this name already exists. Say so and offer to update it (contexts.update) or to activate it.",
        },
        display: { kind: "context_profile", overview: overviewPayload(existing), change: "shown" },
      };
    const { suggestions, problems } = await discoverLinks(env, q);
    const proposal: SurfacePayloads["context_proposal"] = {
      name: clip(q.name, 80),
      kind: q.kind,
      description: q.description ? clip(q.description, 400) : null,
      aliases: q.aliases.map((a) => clip(a, 80)),
      suggestions,
      createdId: null,
    };
    return {
      output: {
        proposal: {
          name: q.name,
          kind: q.kind,
          suggestions: suggestions.map((s) => ({
            id: s.id,
            type: s.type,
            link: s.label,
            confidence: s.confidence,
            ...(s.detail ? { detail: s.detail } : {}),
          })),
        },
        ...(problems.length ? { unavailable: problems } : {}),
        instructions:
          "The proposal is on screen with the likely links pre-selected. In one short sentence, say what you found and ask them to review it and create it (on screen, or by confirming here — then call contexts.create with only the links they keep). Never add possible/uncertain links they didn't confirm. If nothing was found, say so: they can create it and link sources later.",
      },
      display: { kind: "context_proposal", proposal },
    };
  },
};

// ── create / update / archive ────────────────────────────────────────────────

const isoDate = z.string().refine(isIsoDate, "YYYY-MM-DD");
const studyInput = z
  .object({
    targetDate: isoDate.optional().describe("Exam or target date, if said."),
    objective: z.string().trim().max(500).optional(),
    level: z.string().trim().max(60).optional(),
  })
  .strict();

const linkInput = z
  .object({
    type: z.enum(LINK_TYPES),
    resourceId: z.string().trim().min(1).max(600).optional(),
    value: z.string().trim().min(1).max(320).optional(),
    label: z.string().trim().min(1).max(200).optional(),
    person: z
      .object({ name: z.string().trim().min(1).max(200), email: z.string().trim().max(320) })
      .strict()
      .optional(),
  })
  .strict();

/** Model or UI input → validated links (values normalized; resources need their id). */
export function toNewLinks(links: z.infer<typeof linkInput>[]): NewLink[] {
  return links.map((l) => {
    if (l.type === "person" && l.person && !l.resourceId) {
      const email = normalizeLinkValue("email_address", l.person.email);
      if (!email)
        throw new AppError("VALIDATION_ERROR", `Invalid email for ${l.person.name}`, {
          recovery: "review",
        });
      return {
        type: "person",
        label: l.label ?? `${l.person.name} <${email}>`,
        person: { name: l.person.name, email },
      };
    }
    if (isResourceLink(l.type)) {
      if (!l.resourceId)
        throw new AppError("VALIDATION_ERROR", `A ${l.type} link needs the resource's id`, {
          recovery: "review",
        });
      return { type: l.type, resourceId: l.resourceId, label: l.label ?? l.resourceId };
    }
    const value = normalizeLinkValue(l.type, l.value ?? l.label ?? "");
    if (!value)
      throw new AppError("VALIDATION_ERROR", `Invalid ${l.type}: "${l.value ?? l.label ?? ""}"`, {
        recovery: "review",
      });
    return {
      type: l.type as ContextLinkType,
      value,
      label: l.label ?? (l.type === "email_domain" ? `@${value}` : value),
    };
  });
}

const createInput = z
  .object({
    kind: z.enum(CONTEXT_KINDS),
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(1000).optional(),
    aliases: z.array(z.string().trim().min(1).max(80)).max(12).default([]),
    instructions: z
      .string()
      .trim()
      .max(1000)
      .optional()
      .describe('Routing preferences the user stated ("prefer the Work Gmail account").'),
    icon: z.enum(SPACE_ICONS).optional(),
    accent: z.enum(SPACE_COLORS).optional(),
    study: studyInput.optional(),
    links: z.array(linkInput).max(40).default([]),
  })
  .strict();

/** After creating from a proposal: the proposal says so (no second Create). */
function markProposalCreated(env: ToolRunEnv, name: string, id: string) {
  const w = env.ctx.workspace;
  if (!w) return;
  const at = new Date().toISOString();
  w.apply(
    w
      .state()
      .surfaces.filter(
        (s) =>
          s.type === "context_proposal" &&
          nameKey((s.payload as SurfacePayloads["context_proposal"]).name) === nameKey(name),
      )
      .map((s) => ({
        op: "update" as const,
        id: s.id,
        patch: {
          state: "ready" as const,
          payload: { ...(s.payload as SurfacePayloads["context_proposal"]), createdId: id },
        },
        at,
      })),
  );
}

export const createContextTool: ToolDefinition = {
  name: "contexts.create",
  capability: "contexts",
  operation: "create",
  description:
    "Creates a Context Profile — only after contexts.propose and the user's confirmation, with the links they confirmed (resource ids exactly as the proposal gave them). Links only point to existing data; nothing is copied.",
  input: createInput,
  async describe(raw) {
    const q = createInput.parse(raw);
    return { summary: `Create context “${q.name}”` };
  },
  async run(raw, env) {
    const q = createInput.parse(raw);
    const profile = await store(env).create({
      kind: q.kind,
      name: q.name,
      description: q.description ?? null,
      aliases: q.aliases,
      instructions: q.instructions ?? null,
      icon: q.icon ?? null,
      accent: q.accent ?? null,
      study: q.kind === "study" ? (q.study ?? {}) : null,
      links: toNewLinks(q.links),
    });
    markProposalCreated(env, q.name, profile.id);
    await activateContext(env, profile, "activated");
    return {
      output: {
        created: true,
        context: profileForModel(profile),
        instructions:
          "Say it's created and what it's linked to, in one or two sentences. It can be edited in My Elise › Contexts.",
      },
      display: { kind: "context_profile", overview: overviewPayload(profile), change: "created" },
      target: { type: "context_profile", id: profile.id },
    };
  },
};

const updateInput = z
  .object({
    context: contextRef,
    name: z.string().trim().min(1).max(80).optional(),
    description: z.string().trim().max(1000).optional(),
    aliases: z.array(z.string().trim().min(1).max(80)).max(12).optional(),
    instructions: z.string().trim().max(1000).optional(),
    study: studyInput.optional(),
    addLinks: z.array(linkInput).max(20).optional(),
    removeLinks: z
      .array(z.string().trim().min(1).max(600))
      .max(20)
      .optional()
      .describe("Link ids or labels to remove."),
  })
  .strict();

export const updateContextTool: ToolDefinition = {
  name: "contexts.update",
  capability: "contexts",
  operation: "update",
  description:
    'Changes a context: name, aliases, description, routing preferences, study details, or its links ("usá también la lista RSFA", "sacale el dominio viejo").',
  input: updateInput,
  async describe(raw, env) {
    const q = updateInput.parse(raw);
    const p = await findProfile(store(env), q.context);
    return { summary: `Update context “${p.name}”`, target: { type: "context_profile", id: p.id } };
  },
  async run(raw, env) {
    const q = updateInput.parse(raw);
    const s = store(env);
    const p = await findProfile(s, q.context);
    const remove = (q.removeLinks ?? []).flatMap((ref) =>
      p.links
        .filter((l) => l.id === ref || nameKey(l.label) === nameKey(ref) || l.value === ref)
        .map((l) => l.id),
    );
    const updated = await s.update(p.id, {
      ...(q.name ? { name: q.name } : {}),
      ...(q.description !== undefined ? { description: q.description || null } : {}),
      ...(q.aliases ? { aliases: q.aliases } : {}),
      ...(q.instructions !== undefined ? { instructions: q.instructions || null } : {}),
      ...(q.study ? { study: q.study } : {}),
      ...(q.addLinks?.length ? { addLinks: toNewLinks(q.addLinks) } : {}),
      ...(remove.length ? { removeLinkIds: remove } : {}),
    });
    return {
      output: { updated: true, context: profileForModel(updated) },
      display: { kind: "context_profile", overview: overviewPayload(updated), change: "updated" },
      target: { type: "context_profile", id: updated.id },
    };
  },
};

export const archiveContextTool: ToolDefinition = {
  name: "contexts.archive",
  capability: "contexts",
  operation: "archive",
  description:
    "Archives a context. Only the organizational layer: emails, tasks, documents and other data stay exactly where they are.",
  input: getInput,
  async describe(raw, env) {
    const p = await findProfile(store(env), getInput.parse(raw).context);
    return {
      summary: `Archive context “${p.name}”`,
      target: { type: "context_profile", id: p.id },
    };
  },
  async run(raw, env) {
    const p = await findProfile(store(env), getInput.parse(raw).context);
    const archived = await store(env).archive(p.id);
    if (env.ctx.workspace?.state().context?.id === p.id)
      env.ctx.workspace.apply([{ op: "context", context: null, at: new Date().toISOString() }]);
    return {
      output: { archived: true, name: archived.name },
      display: { kind: "context_profile", overview: overviewPayload(archived), change: "archived" },
      target: { type: "context_profile", id: p.id },
    };
  },
};

// ── activate / clear / people ────────────────────────────────────────────────

export const activateContextTool: ToolDefinition = {
  name: "contexts.activate",
  capability: "contexts",
  operation: "activate",
  description:
    '"Ahora hablemos de Firbot", "volvamos a RSFA", "switch to my Administration subject": makes a context the active one for this interaction (retrieval looks there first). Changes no data.',
  input: getInput,
  async describe() {
    return { summary: "Switch context" };
  },
  async run(raw, env) {
    const p = await findProfile(store(env), getInput.parse(raw).context);
    await activateContext(env, p, "activated");
    return {
      output: {
        active: true,
        context: describeActiveContext(p),
        instructions: "Continue scoped to this context; don't restate its details.",
      },
      display: { kind: "context_profile", overview: overviewPayload(p), change: "activated" },
    };
  },
};

export const clearContextTool: ToolDefinition = {
  name: "contexts.clear",
  capability: "contexts",
  operation: "clear",
  description:
    "Clears the active context when the user leaves the subject ('dejemos RSFA', 'otra cosa'). Changes no data.",
  input: z.object({}).strict(),
  async describe() {
    return { summary: "Clear context" };
  },
  async run(_raw, env) {
    env.ctx.workspace?.apply([{ op: "context", context: null, at: new Date().toISOString() }]);
    return { output: { cleared: true } };
  },
};

const peopleInput = z.object({ name: z.string().trim().min(2).max(200) }).strict();

export const findPeopleTool: ToolDefinition = {
  name: "contexts.findPeople",
  capability: "contexts",
  operation: "findPeople",
  description:
    '"¿Qué le debemos a Rod?", "el último mail de Chris": who that person is (name, emails, organization, contexts). Several matches → ask which; never merge people.',
  input: peopleInput,
  async describe() {
    return { summary: "Find person" };
  },
  async run(raw, env) {
    const q = peopleInput.parse(raw);
    const s = store(env);
    const [entities, profiles] = await Promise.all([s.entities(), s.list()]);
    let matches = findPeople(entities, q.name);
    const active = profiles.find((p) => p.id === env.ctx.context?.id);
    if (active && matches.length > 1) {
      const inContext = contextSignals(active, entities).people.map((p) => p.id);
      const scoped = matches.filter((m) => inContext.includes(m.id));
      if (scoped.length) matches = scoped;
    }
    const orgName = (id: string | null) => entities.find((e) => e.id === id)?.name ?? null;
    return {
      output: {
        people: matches.slice(0, 6).map((m) => ({
          id: m.id,
          name: m.name,
          emails: m.emails,
          organization: orgName(m.organizationId),
          contexts: profiles
            .filter((p) => contextSignals(p, entities).people.some((x) => x.id === m.id))
            .map((p) => p.name),
        })),
        ambiguous: matches.length > 1,
        instructions: matches.length
          ? matches.length > 1
            ? "Several people match: ask which one (by full name or email). Never assume."
            : "Use this person's email in email/calendar searches (from/to)."
          : "No known person by that name. Search email by name instead, or ask for the email.",
      },
    };
  },
};

// ── work.brief ───────────────────────────────────────────────────────────────

const briefInput = z
  .object({
    context: contextRef.optional().describe("Omit to use the active context."),
    since: isoDate
      .optional()
      .describe("Only if the user gives a date ('since Monday' → that local date)."),
    focus: z
      .string()
      .trim()
      .min(2)
      .max(200)
      .optional()
      .describe("A topic within the context, if the user narrows it."),
    web: z
      .boolean()
      .default(false)
      .describe(
        "Also look at recent public news about it — only when the user asks for external/web developments.",
      ),
  })
  .strict();

type SourceStatus = SurfacePayloads["context_overview"]["sources"][number];

export const workBriefTool: ToolDefinition = {
  name: "work.brief",
  capability: "contexts",
  operation: "brief",
  description:
    '"Poneme al día con RSFA", "client brief for RSFA", "¿cómo viene ELISE?", "what are the open items with this client?", "what did we promise them?": gathers what changed since the last interaction (email, meetings, tasks, documents, earlier conversations, linked structured data; public news only if asked) into the Live Workspace, with extracted commitments and a timeline. Then write the brief with ui.present.',
  input: briefInput,
  async describe() {
    return { summary: "Work brief" };
  },
  async run(raw, env) {
    const q = briefInput.parse(raw);
    const s = store(env);
    const profile = await targetProfile(env, q.context);
    const entities = await s.entities().catch(() => []);
    const signals = contextSignals(profile, entities);
    const tz = env.ctx.timezone;
    const now = env.ctx.now;
    const today = todayIn(tz, now);
    const w = env.ctx.workspace;
    const at = now.toISOString();
    const intentId = `intent:brief:${profile.id}`;
    w?.apply([
      {
        op: "intent",
        intent: { id: intentId, kind: "work_brief", description: profile.name, startedAt: at },
        at,
      },
    ]);
    await activateContext(env, profile, "activated");
    const loading: SurfaceDraft | null = contextOverviewSurface(overviewPayload(profile), {
      key: profile.id,
      intentId,
    });
    present(env, [loading ? { ...loading, state: "loading" } : null]);
    const opts = (key: string, priority: number) => ({
      key: `${intentId}:${key}`,
      intentId,
      priority,
    });
    const topic = clip([q.focus, profile.name, ...profile.aliases].filter(Boolean).join(" "), 300);
    const lookback = addDays(today, -45);

    const last = await s.lastInteraction(profile.id, threadOf(env)).catch(() => null);

    const [email, calendar, openTasks, doneTasks, knowledge, changes, recall, structured, web] =
      await Promise.all([
        runStep(env, "email", "email.search", async () => {
          const searches: Record<string, unknown>[] = [
            ...[...signals.domains]
              .slice(0, 3)
              .map((d) => ({ from: d, after: lookback, limit: 8 })),
            ...[...signals.domains].slice(0, 2).map((d) => ({ to: d, after: lookback, limit: 5 })),
            ...[...signals.emails]
              .filter((e) => !signals.domains.has(domainOfEmail(e)))
              .slice(0, 3)
              .map((e) => ({ from: e, after: lookback, limit: 5 })),
          ];
          if (!searches.length)
            searches.push({ text: clip(profile.name, 200), after: lookback, limit: 10 });
          const outcomes = await Promise.all(searches.map((x) => invoke(env, "email.search", x)));
          const failed = outcomes.find((o) => o.status !== "succeeded") ?? null;
          const all = outcomes.flatMap((o) => displayOf(o, "email_list")?.messages ?? []);
          // Linked addresses: keep what belongs to them. A name-only search keeps its matches.
          const messages =
            signals.domains.size || signals.emails.size
              ? all.filter((m) => emailMatches(signals, m))
              : all;
          if (!messages.length && failed) return { value: [] as EmailMessage[], outcome: failed };
          present(env, [emailListSurface(messages, { ...opts("email", 70), title: profile.name })]);
          return { value: messages, outcome: null };
        }),
        runStep(env, "calendar", "calendar.listEvents", async () => {
          const outcome = await invoke(env, "calendar.listEvents", {
            from: lookback,
            to: addDays(today, 21),
            limit: 100,
          });
          const events = (displayOf(outcome, "event_list")?.events ?? []).filter(
            (e) => e.status !== "cancelled" && eventMatches(signals, e),
          );
          const next = events.find((e) => Date.parse(e.start) > now.getTime());
          if (next) present(env, [eventSurface(next, opts(`event:${next.id}`, 75))]);
          return { value: events, outcome };
        }),
        runStep(env, "tasks", "tasks.list", async () => {
          const outcome = await invoke(env, "tasks.list", { status: "open", limit: 300 });
          const tasks = (displayOf(outcome, "task_list")?.tasks ?? []).filter((t) =>
            taskMatches(signals, t),
          );
          present(env, [taskListSurface(tasks, { ...opts("tasks", 66), title: profile.name })]);
          return { value: tasks, outcome };
        }),
        runStep(env, "tasks", "tasks.list", async () => {
          const outcome = await invoke(env, "tasks.list", { status: "completed", limit: 100 });
          const tasks = (displayOf(outcome, "task_list")?.tasks ?? []).filter((t) =>
            taskMatches(signals, t),
          );
          return { value: tasks, outcome };
        }),
        runStep(env, "knowledge", "knowledge.search", async () => {
          const outcome = await invoke(env, "knowledge.search", {
            query: clip(
              q.focus ? `${q.focus} ${profile.name}` : `${profile.name} estado avance`,
              500,
            ),
            ...(signals.spaceIds[0]
              ? { space: signals.spaceIds[0] }
              : signals.itemIds[0]
                ? { itemId: signals.itemIds[0] }
                : { everywhere: true }),
          });
          const d = displayOf(outcome, "knowledge_evidence");
          if (d)
            present(env, [
              knowledgeSurface(d.evidence, d.enough, {
                ...opts("knowledge", 55),
                query: profile.name,
              }),
            ]);
          return { value: d?.enough ? d.evidence : ([] as KnowledgeEvidence[]), outcome };
        }),
        signals.spaceIds[0]
          ? runStep(env, "knowledge", "knowledge.listRecentChanges", async () => {
              const outcome = await invoke(env, "knowledge.listRecentChanges", {
                space: signals.spaceIds[0],
                days: 30,
              });
              const out = (outcome.status === "succeeded" ? outcome.output : null) as {
                changes?: { title: string; change: string; at: string }[];
              } | null;
              return { value: out?.changes ?? [], outcome };
            })
          : Promise.resolve(null),
        runStep(env, "recall", "history.search", async () => {
          const outcome = await invoke(env, "history.search", {
            query: topic,
            limit: 3,
            context: profile.id,
          });
          const d = displayOf(outcome, "recall_results");
          if (d) present(env, surfacesFromOutcome("history.search", outcome, opts("recall", 60)));
          return { value: d?.results ?? ([] as RecallResult[]), outcome };
        }),
        signals.structuredSourceIds.length
          ? runStep(env, "structured", "structured.query", async () => {
              const outcomes = await Promise.all(
                signals.structuredSourceIds.slice(0, 2).map(async (source) => {
                  const named = await invoke(env, "structured.query", {
                    source,
                    search: clip(profile.name, 200),
                    limit: 10,
                  });
                  const records = displayOf(named, "structured_records")?.records ?? [];
                  // A source linked as a whole (e.g. this project's board), not a CRM row.
                  return records.length
                    ? named
                    : invoke(env, "structured.query", { source, limit: 10 });
                }),
              );
              for (const o of outcomes)
                present(
                  env,
                  surfacesFromOutcome(
                    "structured.query",
                    o,
                    opts(`structured:${outcomes.indexOf(o)}`, 52),
                  ),
                );
              const failed = outcomes.find((o) => o.status !== "succeeded") ?? null;
              const records = outcomes.flatMap(
                (o) => displayOf(o, "structured_records")?.records ?? [],
              );
              return { value: records, outcome: records.length ? null : failed };
            })
          : Promise.resolve(null),
        q.web
          ? runStep(
              env,
              "web",
              "web.searchNews",
              async () => {
                const outcome = await invoke(env, "web.searchNews", {
                  query: clip(profile.name, 200),
                  recency: "month",
                });
                present(
                  env,
                  surfacesFromOutcome("web.searchNews", outcome, {
                    ...opts("web", 33),
                    title: profile.name,
                  }),
                );
                return { value: displayOf(outcome, "web_news")?.events ?? [], outcome };
              },
              true,
            )
          : Promise.resolve(null),
      ]);

    // Baseline: the user's date, the last interaction about it, the last meeting, or 14 days.
    const pastMeetings = (calendar.value ?? [])
      .filter((e) => Date.parse(e.end) <= now.getTime())
      .sort((a, b) => b.start.localeCompare(a.start));
    const baseline = chooseBaseline({
      explicit: q.since ? startOfDayUtc(q.since, tz).toISOString() : null,
      lastInteraction: last?.at ?? null,
      lastMeeting: pastMeetings[0]?.end ?? null,
      now,
    });
    const since = Date.parse(baseline.since);
    const messages = [...new Map((email.value ?? []).map((m) => [m.threadId, m])).values()].sort(
      (a, b) => b.date.localeCompare(a.date),
    );
    const completed = (doneTasks.value ?? []).filter(
      (t) => t.completedAt && Date.parse(t.completedAt) >= since,
    );

    const commitments = extractCommitments([
      ...messages.slice(0, 12).map((m) => ({
        text: `${m.subject}. ${m.snippet}`,
        source: {
          kind: "email" as const,
          label: clip(`${m.subject} · ${m.from?.name ?? m.from?.email ?? ""}`, 200),
          date: m.date,
          ref: m.threadId,
          author: m.fromMe ? ("us" as const) : ("them" as const),
          counterpart: m.fromMe
            ? (m.to[0]?.name ?? m.to[0]?.email ?? null)
            : (m.from?.name ?? m.from?.email ?? null),
        },
      })),
      ...(recall.value ?? []).flatMap((r) =>
        r.excerpts.map((e) => ({
          text: e.text,
          source: {
            kind: "recall" as const,
            label: clip(r.title, 200),
            date: e.at,
            ref: r.interactionId,
            author: "unknown" as const,
            counterpart: null,
          },
        })),
      ),
    ]).map((c, i) => ({ ...c, id: `c${i + 1}` }));

    const timelineEntries: TimelineEntry[] = [
      ...(calendar.value ?? []).map((e: CalendarEvent) => ({
        at: e.start,
        kind: "meeting" as const,
        title: e.title,
        detail: null,
        upcoming: false,
      })),
      ...messages.slice(0, 8).map((m) => ({
        at: m.date,
        kind: "email" as const,
        title: m.subject || "(no subject)",
        detail: m.from?.name ?? m.from?.email ?? null,
        upcoming: false,
      })),
      ...completed.map((t: Task) => ({
        at: t.completedAt!,
        kind: "task" as const,
        title: t.title,
        detail: "completed",
        upcoming: false,
      })),
      ...((changes?.value ?? []) as { title: string; change: string; at: string }[])
        .slice(0, 6)
        .map((c) => ({
          at: c.at,
          kind: "document" as const,
          title: c.title,
          detail: c.change,
          upcoming: false,
        })),
      ...(recall.value ?? []).map((r) => ({
        at: r.lastActivity,
        kind: "interaction" as const,
        title: r.title,
        detail: null,
        upcoming: false,
      })),
    ].map((e) => ({
      ...e,
      title: clip(e.title, 300),
      detail: e.detail ? clip(e.detail, 200) : null,
    }));
    const timeline = buildTimeline(timelineEntries, now);

    const status = (
      source: string,
      r: { status: "ok" | "unavailable" | "failed" } | null,
      count: number,
    ): SourceStatus | null =>
      r ? { source, status: r.status === "ok" ? (count ? "ok" : "empty") : r.status, count } : null;
    const sources = [
      status("email", email, messages.length),
      status("calendar", calendar, (calendar.value ?? []).length),
      status("tasks", openTasks, (openTasks.value ?? []).length),
      status("knowledge", knowledge, (knowledge.value ?? []).length),
      status("recall", recall, (recall.value ?? []).length),
      status("structured", structured, (structured?.value ?? []).length),
      status("web", web, (web?.value ?? []).length),
    ].filter((x): x is SourceStatus => x !== null);

    const overview = overviewPayload(profile, { baseline, sources });
    const display = {
      kind: "work_brief" as const,
      overview,
      commitments: { contextName: clip(profile.name, 120), items: commitments },
      timeline: { contextName: clip(profile.name, 120), entries: timeline },
    };
    present(
      env,
      surfacesFromOutcome(
        "work.brief",
        { status: "succeeded", display },
        { key: intentId, intentId },
      ),
    );

    const local = (iso: string) => toLocalDateTime(new Date(iso), tz);
    const isNew = (iso: string) => Date.parse(iso) >= since;
    const unavailable = [email, calendar, openTasks, knowledge, recall, structured, web]
      .filter((r): r is NonNullable<typeof r> => !!r && r.problem !== null)
      .map((r) => r.problem!);
    const records = (structured?.value ?? []) as StructuredRecord[];
    return {
      output: {
        context: profileForModel(profile),
        baseline: {
          since: local(baseline.since).slice(0, 10),
          basis: baseline.basis,
          ...(baseline.basis === "last_interaction" && last?.title
            ? { interaction: last.title }
            : {}),
        },
        internal: {
          communication: messages.slice(0, 6).map((m) => ({
            thread: m.threadId,
            subject: m.subject,
            from: m.from?.name ?? m.from?.email ?? null,
            date: local(m.date).slice(0, 10),
            sinceBaseline: isNew(m.date),
            fromUser: m.fromMe,
            untrustedSnippet: clip(m.snippet, 220),
          })),
          meetings: {
            recent: pastMeetings.slice(0, 3).map((e) => ({ title: e.title, date: local(e.start) })),
            upcoming: (calendar.value ?? [])
              .filter((e) => Date.parse(e.start) > now.getTime())
              .slice(0, 3)
              .map((e) => ({ event: e.id, title: e.title, start: local(e.start) })),
          },
          openTasks: (openTasks.value ?? []).slice(0, 8).map((t) => ({
            task: t.id,
            title: t.title,
            due: t.dueDate,
            source: t.provenance.source,
          })),
          completedSinceBaseline: completed.slice(0, 5).map((t) => t.title),
          documents: [...new Map((knowledge.value ?? []).map((e) => [e.itemId, e])).values()]
            .slice(0, 4)
            .map((e) => ({
              document: e.title,
              space: e.spaceName,
              untrustedPassage: clip(e.snippet, 260),
            })),
          documentChanges: (
            (changes?.value ?? []) as { title: string; change: string; at: string }[]
          )
            .filter((c) => isNew(c.at))
            .slice(0, 6),
          earlierConversations: (recall.value ?? []).map((r) => ({
            interaction: r.interactionId,
            date: r.date.slice(0, 10),
            title: r.title,
            ...(r.summary ? { summary: r.summary } : {}),
            untrustedExcerpts: r.excerpts.map((e) => clip(e.text, 300)),
          })),
          records: records.slice(0, 8).map((r) => ({
            title: r.title,
            source: r.provenance.source,
            untrustedValues: clip(JSON.stringify(r.values), 300),
          })),
          commitments: commitments.map((c) => ({
            item: c.id,
            direction: c.direction,
            untrustedQuote: c.text,
            who: c.who,
            from: `${c.source.kind}: ${c.source.label}`,
            date: c.source.date?.slice(0, 10) ?? null,
          })),
        },
        ...(web?.value?.length
          ? {
              external: (
                web.value as {
                  headline: string;
                  items: { url: string; domain: string; publishedAt: string | null }[];
                }[]
              )
                .slice(0, 4)
                .map((e) => ({
                  headline: e.headline,
                  url: e.items[0]?.url,
                  domain: e.items[0]?.domain,
                  date: e.items[0]?.publishedAt?.slice(0, 10) ?? null,
                })),
            }
          : {}),
        unavailable,
        instructions: `The workspace shows every source found. Now call ui.present {type:'summary'} with the brief: facts (current status only as the evidence shows it), changes (what changed since the baseline — state it: ${
          baseline.basis === "default_window"
            ? "no earlier interaction about it was found, so say you're covering the last 14 days"
            : baseline.basis === "user"
              ? "since the date the user gave"
              : `"since your last ${baseline.basis === "last_interaction" ? "interaction about" : "meeting with"} ${profile.name} on <date>"`
        }), open_items (open tasks and commitments — commitments are quoted evidence; say who said it), questions or attention points (suggestions, clearly yours), material. Internal evidence and public web results stay in separate items; label web as public and cite it as links. Never manufacture a status: if evidence is thin, say what is known and what is missing. Name unavailable sources. Never put ids (task, thread, interaction) in the brief's text. Then reply in two or three sentences without repeating the Surfaces. Don't create tasks from commitments unless the user asks.`,
      },
      display,
    };
  },
};

export const CONTEXT_TOOLS = [
  listContextsTool,
  getContextTool,
  proposeContextTool,
  createContextTool,
  updateContextTool,
  archiveContextTool,
  activateContextTool,
  clearContextTool,
  findPeopleTool,
  workBriefTool,
];

import "server-only";

import {
  activeContextOf,
  CONTEXT_LIMITS,
  domainOfEmail,
  isResourceLink,
  nameKey,
  type ContextLink,
  type ContextLinkType,
  type ContextPatch,
  type ContextProfile,
  type ContextStore,
  type ContextThread,
  type DiscoveryCatalog,
  type Entity,
  type NewContext,
  type NewLink,
} from "@/core/contexts/model";
import { AppError } from "@/core/errors";
import { logger } from "@/infrastructure/observability/logger";
import type {
  ContextLinkRow,
  ContextProfileRow,
  EntityRow,
} from "@/infrastructure/supabase/database.types";

import type { AuthContext } from "./auth-context";
import { listSpaces } from "./knowledge-service";

/**
 * Context Profiles store (ADR-016), through the user's session: RLS keeps every row in the
 * workspace, and a database trigger checks that every link points at a record of the same
 * workspace. Nothing here copies linked data — profiles, links and people only.
 */

type Origin = "ai" | "user_ui";

/** Changes made in My Elise are audited here; ELISE's own changes are audited by the executor. */
export async function auditContextChange(
  auth: AuthContext,
  eventType: string,
  contextId: string,
  metadata: Record<string, string | number | boolean> = {},
) {
  await auth.db.from("audit_events").insert({
    workspace_id: auth.workspaceId,
    user_id: auth.userId,
    event_type: eventType,
    resource_type: "context_profile",
    resource_id: contextId,
    origin: "user_ui",
    result: "success",
    metadata,
  });
}

const toLink = (r: ContextLinkRow): ContextLink => ({
  id: r.id,
  type: r.link_type as ContextLinkType,
  resourceId: r.resource_id,
  value: r.value,
  label: r.label,
  confirmed: r.confirmed,
});

/** A Section's own Space, always part of where its context lives (never stored as a link). */
export const SECTION_LINK_PREFIX = "section:";

type SpaceNames = Map<string, { name: string; parentId: string | null }>;

function sectionOf(r: ContextProfileRow, spaces: SpaceNames): ContextProfile["section"] {
  const space = r.knowledge_space_id ? spaces.get(r.knowledge_space_id) : undefined;
  const parent = space?.parentId ? spaces.get(space.parentId) : undefined;
  return space && parent
    ? { spaceId: r.knowledge_space_id!, parentId: space.parentId!, parentName: parent.name }
    : null;
}

const toProfile = (
  r: ContextProfileRow,
  links: ContextLinkRow[],
  spaces: SpaceNames = new Map(),
): ContextProfile =>
  withSectionLink({
    id: r.id,
    kind: r.kind,
    name: r.name,
    description: r.description,
    aliases: r.aliases ?? [],
    icon: r.icon,
    accent: r.accent,
    status: r.status,
    instructions: r.instructions,
    // Any context can be studied (ADR-020): its study details exist once someone set them.
    study:
      r.kind === "study" || r.study_target_date || r.study_objective || r.study_level
        ? { targetDate: r.study_target_date, objective: r.study_objective, level: r.study_level }
        : null,
    links: links.filter((l) => l.context_profile_id === r.id).map(toLink),
    section: sectionOf(r, spaces),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });

function withSectionLink(p: ContextProfile): ContextProfile {
  const s = p.section;
  if (!s || p.links.some((l) => l.type === "knowledge_space" && l.resourceId === s.spaceId))
    return p;
  return {
    ...p,
    links: [
      {
        id: `${SECTION_LINK_PREFIX}${s.spaceId}`,
        type: "knowledge_space",
        resourceId: s.spaceId,
        value: null,
        label: `${s.parentName} › ${p.name}`,
        confirmed: true,
      },
      ...p.links,
    ],
  };
}

const toEntity = (r: EntityRow): Entity => ({
  id: r.id,
  type: r.entity_type,
  name: r.name,
  aliases: r.aliases ?? [],
  emails: r.emails ?? [],
  domains: r.domains ?? [],
  organizationId: r.organization_id,
});

function dbError(error: { code?: string; message?: string } | null, what: string): never {
  if (error?.code === "23505")
    throw new AppError("CONFLICT", `${what} already exists`, { recovery: "review", cause: error });
  if (error?.message?.includes("invalid context link"))
    throw new AppError("VALIDATION_ERROR", "A link points to something that isn't available", {
      recovery: "review",
      cause: error,
    });
  throw new AppError("INTERNAL_ERROR", `Could not save ${what.toLowerCase()}`, { cause: error });
}

async function loadProfiles(
  auth: AuthContext,
  opts: { includeArchived?: boolean; id?: string } = {},
) {
  let q = auth.db.from("context_profiles").select("*").eq("workspace_id", auth.workspaceId);
  if (!opts.includeArchived) q = q.eq("status", "active");
  if (opts.id) q = q.eq("id", opts.id);
  const { data: rows, error } = await q.order("name");
  if (error) throw new AppError("INTERNAL_ERROR", "Could not load contexts", { cause: error });
  if (!rows?.length) return [];
  const [{ data: links }, { data: spaces }] = await Promise.all([
    auth.db
      .from("context_links")
      .select("*")
      .eq("workspace_id", auth.workspaceId)
      .in(
        "context_profile_id",
        rows.map((r) => r.id),
      )
      .order("created_at"),
    rows.some((r) => r.knowledge_space_id)
      ? auth.db
          .from("knowledge_spaces")
          .select("id, name, parent_space_id")
          .eq("workspace_id", auth.workspaceId)
          .eq("status", "active")
      : Promise.resolve({
          data: [] as { id: string; name: string; parent_space_id: string | null }[],
        }),
  ]);
  const names: SpaceNames = new Map(
    (spaces ?? []).map((s) => [s.id, { name: s.name, parentId: s.parent_space_id }]),
  );
  return rows.map((r) => toProfile(r, links ?? [], names));
}

/** A person for a confirmed `person` link: reused by email, never merged by name. */
async function personFor(
  auth: AuthContext,
  person: { name: string; email: string },
  organizationId: string | null,
  origin: Origin,
): Promise<string> {
  const email = person.email.toLowerCase();
  const { data: existing } = await auth.db
    .from("entities")
    .select("id, organization_id")
    .eq("workspace_id", auth.workspaceId)
    .is("archived_at", null)
    .contains("emails", [email])
    .maybeSingle();
  if (existing) {
    if (organizationId && !existing.organization_id)
      await auth.db
        .from("entities")
        .update({ organization_id: organizationId })
        .eq("id", existing.id)
        .eq("workspace_id", auth.workspaceId);
    return existing.id;
  }
  const { data, error } = await auth.db
    .from("entities")
    .insert({
      workspace_id: auth.workspaceId,
      entity_type: "person",
      name: person.name.slice(0, 200),
      name_key: nameKey(person.name).slice(0, 200),
      emails: [email],
      domains: [domainOfEmail(email)],
      organization_id: organizationId,
      source: origin,
    })
    .select("id")
    .single();
  if (error || !data) dbError(error, "That person");
  return data.id;
}

/** The organization behind a client's email domains (one per profile, by name). */
async function organizationFor(
  auth: AuthContext,
  name: string,
  domains: string[],
  origin: Origin,
): Promise<string> {
  const key = nameKey(name).slice(0, 200);
  const { data: existing } = await auth.db
    .from("entities")
    .select("id, domains")
    .eq("workspace_id", auth.workspaceId)
    .eq("entity_type", "organization")
    .eq("name_key", key)
    .is("archived_at", null)
    .maybeSingle();
  if (existing) {
    const merged = [...new Set([...(existing.domains ?? []), ...domains])].slice(0, 10);
    if (merged.length !== (existing.domains ?? []).length)
      await auth.db
        .from("entities")
        .update({ domains: merged })
        .eq("id", existing.id)
        .eq("workspace_id", auth.workspaceId);
    return existing.id;
  }
  const { data, error } = await auth.db
    .from("entities")
    .insert({
      workspace_id: auth.workspaceId,
      entity_type: "organization",
      name: name.slice(0, 200),
      name_key: key,
      domains: domains.slice(0, 10),
      source: origin,
    })
    .select("id")
    .single();
  if (error || !data) dbError(error, "That organization");
  return data.id;
}

async function insertLinks(
  auth: AuthContext,
  profile: { id: string; name: string; kind: string },
  links: NewLink[],
  origin: Origin,
) {
  if (!links.length) return;
  const domains = links.filter((l) => l.type === "email_domain" && l.value).map((l) => l.value!);
  // A client's domains are an organization; its confirmed people belong to it.
  const orgId =
    domains.length && profile.kind !== "study"
      ? await organizationFor(auth, profile.name, domains, origin)
      : null;
  const rows: Omit<ContextLinkRow, "id" | "created_at" | "metadata">[] = [];
  for (const l of links) {
    const resourceId =
      l.type === "person" && l.person
        ? await personFor(auth, l.person, orgId, origin)
        : isResourceLink(l.type)
          ? (l.resourceId ?? null)
          : null;
    rows.push({
      workspace_id: auth.workspaceId,
      context_profile_id: profile.id,
      link_type: l.type,
      resource_id: resourceId,
      value: isResourceLink(l.type) ? null : (l.value ?? null),
      label: l.label.slice(0, 200),
      confirmed: true,
      source: origin,
    });
  }
  if (orgId && !links.some((l) => l.type === "organization"))
    rows.push({
      workspace_id: auth.workspaceId,
      context_profile_id: profile.id,
      link_type: "organization",
      resource_id: orgId,
      value: null,
      label: profile.name.slice(0, 200),
      confirmed: true,
      source: origin,
    });
  const unique = [
    ...new Map(rows.map((r) => [`${r.link_type}:${r.resource_id ?? r.value}`, r])).values(),
  ];
  // One by one: an existing identical link is skipped (the unique index is on an expression).
  for (const r of unique) {
    const { error } = await auth.db.from("context_links").insert(r);
    if (error && error.code !== "23505") dbError(error, "That link");
  }
}

const studyColumns = (study: NewContext["study"] | ContextPatch["study"]) =>
  study
    ? {
        ...(study.targetDate !== undefined ? { study_target_date: study.targetDate || null } : {}),
        ...(study.objective !== undefined ? { study_objective: study.objective || null } : {}),
        ...(study.level !== undefined ? { study_level: study.level || null } : {}),
      }
    : {};

export async function createContextProfile(
  auth: AuthContext,
  input: NewContext,
  origin: Origin,
): Promise<ContextProfile> {
  const aliases = [...new Set(input.aliases?.map((a) => a.trim()).filter(Boolean) ?? [])].slice(
    0,
    CONTEXT_LIMITS.aliases,
  );
  const { data, error } = await auth.db
    .from("context_profiles")
    .insert({
      workspace_id: auth.workspaceId,
      kind: input.kind,
      name: input.name.trim().slice(0, 80),
      name_key: nameKey(input.name).slice(0, 80),
      description: input.description ?? null,
      aliases,
      instructions: input.instructions ?? null,
      icon: input.icon ?? null,
      accent: input.accent ?? null,
      // Study details belong to any context that is studied, not to a "study" type.
      ...studyColumns(input.study),
      knowledge_space_id: input.sectionSpaceId ?? null,
      source: origin,
      created_by_user_id: auth.userId,
    })
    .select("*")
    .single();
  if (error || !data) dbError(error, `A context called “${input.name}”`);
  try {
    await insertLinks(auth, data, input.links.slice(0, CONTEXT_LIMITS.links), origin);
  } catch (e) {
    // Never leave a half-made profile behind.
    await auth.db
      .from("context_profiles")
      .delete()
      .eq("id", data.id)
      .eq("workspace_id", auth.workspaceId);
    throw e;
  }
  logger.info("context.created", {
    workspace_id: auth.workspaceId,
    kind: input.kind,
    links: input.links.length,
    origin,
  });
  return (await loadProfiles(auth, { id: data.id }))[0]!;
}

export async function updateContextProfile(
  auth: AuthContext,
  id: string,
  patch: ContextPatch,
  origin: Origin,
): Promise<ContextProfile> {
  const [current] = await loadProfiles(auth, { id, includeArchived: true });
  if (!current) throw new AppError("NOT_FOUND", "Context not found", { recovery: "review" });
  const fields = {
    ...(patch.name
      ? { name: patch.name.trim().slice(0, 80), name_key: nameKey(patch.name).slice(0, 80) }
      : {}),
    ...(patch.description !== undefined ? { description: patch.description } : {}),
    ...(patch.aliases
      ? { aliases: [...new Set(patch.aliases)].slice(0, CONTEXT_LIMITS.aliases) }
      : {}),
    ...(patch.instructions !== undefined ? { instructions: patch.instructions } : {}),
    ...(patch.icon !== undefined ? { icon: patch.icon } : {}),
    ...(patch.accent !== undefined ? { accent: patch.accent } : {}),
    ...studyColumns(patch.study),
  };
  if (Object.keys(fields).length) {
    const { error } = await auth.db
      .from("context_profiles")
      .update(fields)
      .eq("id", id)
      .eq("workspace_id", auth.workspaceId);
    if (error) dbError(error, `A context called “${patch.name}”`);
    // A Section's name is its Space's name: one name, two views of it.
    if (patch.name && current.section)
      await auth.db
        .from("knowledge_spaces")
        .update({ name: patch.name.trim().slice(0, 80) })
        .eq("id", current.section.spaceId)
        .eq("workspace_id", auth.workspaceId);
  }
  const removable = patch.removeLinkIds?.filter((x) => !x.startsWith(SECTION_LINK_PREFIX));
  if (removable?.length)
    await auth.db
      .from("context_links")
      .delete()
      .eq("context_profile_id", id)
      .eq("workspace_id", auth.workspaceId)
      .in("id", removable);
  if (patch.addLinks?.length)
    await insertLinks(
      auth,
      { id, name: patch.name ?? current.name, kind: current.kind },
      patch.addLinks,
      origin,
    );
  logger.info("context.updated", { workspace_id: auth.workspaceId, origin });
  return (await loadProfiles(auth, { id, includeArchived: true }))[0]!;
}

export async function setContextArchived(auth: AuthContext, id: string, archived: boolean) {
  const { data, error } = await auth.db
    .from("context_profiles")
    .update(
      archived
        ? { status: "archived", archived_at: new Date().toISOString() }
        : { status: "active", archived_at: null },
    )
    .eq("id", id)
    .eq("workspace_id", auth.workspaceId)
    .select("id")
    .maybeSingle();
  if (error) dbError(error, "A context with that name");
  if (!data) throw new AppError("NOT_FOUND", "Context not found", { recovery: "review" });
  logger.info(archived ? "context.archived" : "context.restored", {
    workspace_id: auth.workspaceId,
  });
  return (await loadProfiles(auth, { id, includeArchived: true }))[0]!;
}

/**
 * Deletes the organizational layer: the profile, its links and its interaction associations.
 * Study progress goes with it, so it needs an explicit confirmation when there is some.
 * Emails, tasks, Knowledge, Notion and calendar data are never touched.
 */
export async function deleteContextProfile(
  auth: AuthContext,
  id: string,
  opts: { deleteStudyProgress: boolean },
) {
  const { count } = await auth.db
    .from("study_concepts")
    .select("id", { count: "exact", head: true })
    .eq("context_profile_id", id);
  const { count: sessions } = await auth.db
    .from("study_sessions")
    .select("id", { count: "exact", head: true })
    .eq("context_profile_id", id);
  if (((count ?? 0) > 0 || (sessions ?? 0) > 0) && !opts.deleteStudyProgress)
    throw new AppError(
      "VALIDATION_ERROR",
      "This subject has study progress. Confirm deleting it too, or archive the context instead.",
      { recovery: "review" },
    );
  const { error } = await auth.db
    .from("context_profiles")
    .delete()
    .eq("id", id)
    .eq("workspace_id", auth.workspaceId);
  if (error) dbError(error, "That context");
  logger.info("context.deleted", { workspace_id: auth.workspaceId });
}

/** What a link can point at, by name (for the management UI and for suggestions). */
export async function contextCatalog(
  auth: AuthContext,
  taskLists: () => Promise<DiscoveryCatalog["taskLists"]>,
): Promise<DiscoveryCatalog> {
  const [spaces, lists, structured, accounts, taskListsResult] = await Promise.all([
    listSpaces(auth).catch(() => []),
    auth.db
      .from("lists")
      .select("id, name")
      .eq("workspace_id", auth.workspaceId)
      .eq("status", "active")
      .limit(100),
    auth.db
      .from("structured_sources")
      .select("id, name, context, status")
      .eq("workspace_id", auth.workspaceId)
      .neq("status", "archived")
      .limit(50),
    auth.db
      .from("provider_connections")
      .select("id, display_name, account_label, status")
      .eq("workspace_id", auth.workspaceId)
      .neq("provider_key", "elise_native")
      .limit(30),
    taskLists().catch(() => []),
  ]);
  return {
    spaces: spaces.map((s) => ({ id: s.id, name: s.name, path: s.path })),
    taskLists: taskListsResult,
    structuredSources: (structured.data ?? []).map((s) => ({
      id: s.id,
      name: s.name,
      context: s.context,
    })),
    accounts: (accounts.data ?? []).map((a) => ({
      connectionId: a.id,
      label: a.display_name,
      account: a.account_label,
    })),
    lists: lists.data ?? [],
  };
}

export async function listContextProfiles(auth: AuthContext, includeArchived = false) {
  return loadProfiles(auth, { includeArchived });
}

/** For the context indicator: names and kinds only; never blocks the page. */
export async function contextOptions(auth: AuthContext) {
  try {
    // A Section reads "University › Mathematics" wherever contexts are listed.
    return (await loadProfiles(auth)).map(activeContextOf);
  } catch {
    return [];
  }
}

export async function getContextProfile(auth: AuthContext, id: string) {
  return (await loadProfiles(auth, { id, includeArchived: true }))[0] ?? null;
}

export async function listEntities(auth: AuthContext): Promise<Entity[]> {
  const { data } = await auth.db
    .from("entities")
    .select("*")
    .eq("workspace_id", auth.workspaceId)
    .is("archived_at", null)
    .limit(500);
  return (data ?? []).map(toEntity);
}

/** Records that an interaction belongs to a context (idempotent; never retroactive). */
export async function associateInteraction(
  auth: AuthContext,
  contextId: string,
  thread: ContextThread,
  source: "activated" | "study" | "meeting",
) {
  const column = thread.kind === "conversation" ? "conversation_id" : "session_id";
  const now = new Date().toISOString();
  const { data: existing } = await auth.db
    .from("context_interactions")
    .select("id")
    .eq("context_profile_id", contextId)
    .eq(column, thread.id)
    .maybeSingle();
  if (existing) {
    await auth.db.from("context_interactions").update({ last_at: now }).eq("id", existing.id);
    return;
  }
  const { error } = await auth.db.from("context_interactions").insert({
    workspace_id: auth.workspaceId,
    user_id: auth.userId,
    context_profile_id: contextId,
    conversation_id: thread.kind === "conversation" ? thread.id : null,
    session_id: thread.kind === "session" ? thread.id : null,
    source,
    first_at: now,
    last_at: now,
  });
  if (error && error.code !== "23505")
    logger.warn("context.associate_failed", { code: error.code ?? "UNKNOWN" });
}

/** The latest earlier interaction about the context, for "since your last … on Sep 28". */
async function lastInteraction(
  auth: AuthContext,
  contextId: string,
  exclude: ContextThread | null,
) {
  const { data } = await auth.db
    .from("context_interactions")
    .select("conversation_id, session_id, last_at")
    .eq("context_profile_id", contextId)
    .eq("user_id", auth.userId)
    .order("last_at", { ascending: false })
    .limit(4);
  const row = (data ?? []).find(
    (r) =>
      !exclude ||
      (exclude.kind === "conversation" ? r.conversation_id : r.session_id) !== exclude.id,
  );
  if (!row) return null;
  const title = row.conversation_id
    ? (
        await auth.db
          .from("conversations")
          .select("title")
          .eq("id", row.conversation_id)
          .maybeSingle()
      ).data?.title
    : (
        await auth.db
          .from("interaction_sessions")
          .select("title")
          .eq("id", row.session_id!)
          .maybeSingle()
      ).data?.title;
  return { at: row.last_at, title: title ?? null };
}

/** The ContextStore port for tools (origin "ai": the executor records who acted). */
export function contextStore(
  auth: AuthContext,
  taskLists: () => Promise<DiscoveryCatalog["taskLists"]>,
): ContextStore {
  return {
    list: () => loadProfiles(auth),
    entities: () => listEntities(auth),
    create: async (input) => {
      if (!input.parentSpaceId) return createContextProfile(auth, input, "ai");
      // ELISE creating "Client A" in "Acme Studio" makes a Section there (ADR-018).
      const { createSection, sectionProfile } = await import("./sections-service");
      const { id } = await createSection(auth, {
        parentId: input.parentSpaceId,
        name: input.name,
        description: input.description ?? null,
        icon: input.icon ?? null,
        color: input.accent ?? null,
        kind: input.kind,
      });
      const profile = await sectionProfile(auth, id);
      if (!profile) throw new AppError("INTERNAL_ERROR", "Could not create the Section");
      return updateContextProfile(
        auth,
        profile.id,
        {
          ...(input.aliases?.length ? { aliases: input.aliases } : {}),
          ...(input.instructions ? { instructions: input.instructions } : {}),
          ...(input.study ? { study: input.study } : {}),
          addLinks: input.links,
        },
        "ai",
      );
    },
    update: (id, patch) => updateContextProfile(auth, id, patch, "ai"),
    archive: (id) => setContextArchived(auth, id, true),
    catalog: () => contextCatalog(auth, taskLists),
    lastInteraction: (id, exclude) => lastInteraction(auth, id, exclude),
    associate: (id, thread, source) => associateInteraction(auth, id, thread, source),
  };
}

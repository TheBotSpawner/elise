import "server-only";

import { MODEL_POLICY } from "@/core/agents/model-policy";
import { AppError } from "@/core/errors";
import { parseSkillMarkdown, toSkillMarkdown } from "@/core/skills/markdown";
import {
  composeInstructions,
  METHOD_LIMITS,
  normalizeMethod,
  scopeOf,
  type Method,
  type MethodReference,
  type MethodScope,
  type MethodStore,
  type MethodSummary,
  type MethodVersion,
  type NewMethod,
  type Provenance,
  type SpaceRef,
} from "@/core/skills/model";
import { scopeLabel } from "@/core/tools/methods";
import { getAIProvider } from "@/infrastructure/ai";
import { logger } from "@/infrastructure/observability/logger";
import type {
  Json,
  MethodReferenceRow,
  MethodRow,
  MethodVersionRow,
} from "@/infrastructure/supabase/database.types";

import { attachmentText } from "./attachments-service";
import type { AuthContext } from "./auth-context";

/**
 * Methods store and services (ADR-040). Methods are shared by the workspace, like its Knowledge
 * (RLS: members). Versions are written by the database itself on every content change, so no
 * path — UI, ELISE, import — can change a Method without leaving its previous version behind.
 */

const SUMMARY_COLUMNS =
  "id, name, description, hints, space_id, platforms, version, updated_at, status" as const;

type SummaryRow = Pick<
  MethodRow,
  | "id"
  | "name"
  | "description"
  | "hints"
  | "space_id"
  | "platforms"
  | "version"
  | "updated_at"
  | "status"
>;

const toSummary = (r: SummaryRow): MethodSummary & { status: Method["status"] } => ({
  id: r.id,
  name: r.name,
  description: r.description,
  hints: r.hints,
  spaceId: r.space_id,
  platforms: r.platforms,
  version: r.version,
  updatedAt: r.updated_at,
  status: r.status,
});

const toMethod = (r: MethodRow): Method => ({
  ...toSummary(r),
  instructions: r.instructions,
  changeSummary: r.change_summary,
  createdAt: r.created_at,
});

const toReference = (r: MethodReferenceRow): MethodReference => ({
  id: r.id,
  kind: r.kind,
  title: r.title,
  sourceType: r.source_type,
  mimeType: r.mime_type,
  attachmentId: r.attachment_id,
  knowledgeItemId: r.knowledge_item_id,
  content: r.content,
  createdAt: r.created_at,
});

const toVersion = (r: MethodVersionRow): MethodVersion => ({
  version: r.version,
  name: r.name,
  description: r.description,
  instructions: r.instructions,
  hints: r.hints,
  spaceId: r.space_id,
  changeSummary: r.change_summary,
  changeSource: r.change_source,
  createdAt: r.created_at,
});

const json = (v: unknown) => JSON.parse(JSON.stringify(v ?? {})) as Json;

function dbError(error: { message?: string } | null, what: string): never {
  if (error?.message?.includes("same workspace"))
    throw new AppError("VALIDATION_ERROR", "That Space isn't in this workspace", {
      recovery: "review",
      cause: error,
    });
  throw new AppError("INTERNAL_ERROR", `Could not ${what}`, { cause: error });
}

export function methodStore(auth: AuthContext): MethodStore {
  const one = async (id: string) => {
    const { data } = await auth.db
      .from("methods")
      .select("*")
      .eq("workspace_id", auth.workspaceId)
      .eq("id", id)
      .maybeSingle();
    if (!data) throw new AppError("NOT_FOUND", "Method not found", { recovery: "review" });
    return toMethod(data);
  };
  const audit = (
    event: string,
    id: string,
    metadata: Record<string, unknown> = {},
    source?: Provenance["source"],
  ) =>
    auth.db.from("audit_events").insert({
      workspace_id: auth.workspaceId,
      user_id: auth.userId,
      event_type: event,
      resource_type: "method",
      resource_id: id,
      origin: !source ? "system" : source.startsWith("ai_") ? "ai" : "user_ui",
      result: "success",
      metadata: json(metadata),
    });
  return {
    async index() {
      const { data } = await auth.db
        .from("methods")
        .select(SUMMARY_COLUMNS)
        .eq("workspace_id", auth.workspaceId)
        .eq("status", "active")
        .order("updated_at", { ascending: false })
        .limit(1000);
      return (data ?? []).map(toSummary);
    },
    async list() {
      const { data } = await auth.db
        .from("methods")
        .select(SUMMARY_COLUMNS)
        .eq("workspace_id", auth.workspaceId)
        .order("updated_at", { ascending: false })
        .limit(1000);
      return (data ?? []).map(toSummary);
    },
    get: one,
    async create(input: NewMethod, p: Provenance) {
      const { data, error } = await auth.db
        .from("methods")
        .insert({
          workspace_id: auth.workspaceId,
          space_id: input.spaceId ?? null,
          name: input.name,
          description: input.description,
          instructions: input.instructions,
          hints: input.hints ?? [],
          ...(input.platforms ? { platforms: input.platforms } : {}),
          change_summary: p.summary.slice(0, METHOD_LIMITS.changeSummary),
          change_source: p.source,
          change_ref: json(p.ref),
          created_by_user_id: auth.userId,
          updated_by_user_id: auth.userId,
        })
        .select("*")
        .single();
      if (error || !data) dbError(error, "save the method");
      await audit("method.created", data.id, { source: p.source }, p.source);
      logger.info("method.created", { source: p.source, scoped: Boolean(input.spaceId) });
      return toMethod(data);
    },
    async update(id, patch, p) {
      const { data, error } = await auth.db
        .from("methods")
        .update({
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.description !== undefined ? { description: patch.description } : {}),
          ...(patch.instructions !== undefined ? { instructions: patch.instructions } : {}),
          ...(patch.hints !== undefined ? { hints: patch.hints } : {}),
          ...(patch.platforms !== undefined ? { platforms: patch.platforms } : {}),
          ...(patch.spaceId !== undefined ? { space_id: patch.spaceId } : {}),
          change_summary: p.summary.slice(0, METHOD_LIMITS.changeSummary),
          change_source: p.source,
          change_ref: json(p.ref),
          updated_by_user_id: auth.userId,
        })
        .eq("id", id)
        .eq("workspace_id", auth.workspaceId)
        .select("*")
        .maybeSingle();
      if (error) dbError(error, "update the method");
      if (!data) throw new AppError("NOT_FOUND", "Method not found", { recovery: "review" });
      await audit("method.updated", id, { source: p.source, version: data.version }, p.source);
      logger.info("method.updated", { source: p.source, version: data.version });
      return toMethod(data);
    },
    async setStatus(id, status) {
      const { data, error } = await auth.db
        .from("methods")
        .update({ status, updated_by_user_id: auth.userId })
        .eq("id", id)
        .eq("workspace_id", auth.workspaceId)
        .select("*")
        .maybeSingle();
      if (error) dbError(error, "change the method");
      if (!data) throw new AppError("NOT_FOUND", "Method not found", { recovery: "review" });
      await audit(status === "archived" ? "method.archived" : "method.restored", id);
      return toMethod(data);
    },
    async versions(id) {
      const { data } = await auth.db
        .from("method_versions")
        .select("*")
        .eq("workspace_id", auth.workspaceId)
        .eq("method_id", id)
        .order("version", { ascending: false })
        .limit(100);
      return (data ?? []).map(toVersion);
    },
    async references(id) {
      const { data } = await auth.db
        .from("method_references")
        .select("*")
        .eq("workspace_id", auth.workspaceId)
        .eq("method_id", id)
        .order("created_at");
      return (data ?? []).map(toReference);
    },
    async addReference(id, ref) {
      let row: {
        title: string;
        content: string | null;
        mime_type: string | null;
        source_type: MethodReferenceRow["source_type"];
        attachment_id?: string;
        knowledge_item_id?: string;
      };
      if (ref.source === "attachment") {
        const file = await attachmentText(auth, ref.attachmentId);
        row = {
          title: (ref.title ?? file.name).slice(0, 200),
          content: file.text.slice(0, METHOD_LIMITS.referenceChars),
          mime_type: file.mimeType,
          source_type: "chat_attachment",
          attachment_id: file.id,
        };
      } else if (ref.source === "knowledge_item") {
        const { data: item } = await auth.db
          .from("knowledge_items")
          .select("id, title, mime_type")
          .eq("workspace_id", auth.workspaceId)
          .eq("id", ref.itemId)
          .maybeSingle();
        if (!item) throw new AppError("NOT_FOUND", "Document not found", { recovery: "review" });
        row = {
          title: item.title.slice(0, 200),
          content: null,
          mime_type: item.mime_type,
          source_type: "knowledge_item",
          knowledge_item_id: item.id,
        };
      } else {
        row = {
          title: ref.title.slice(0, 200),
          content: ref.content.slice(0, METHOD_LIMITS.referenceChars),
          mime_type: "text/plain",
          source_type: "text",
        };
      }
      const { data, error } = await auth.db
        .from("method_references")
        .insert({
          workspace_id: auth.workspaceId,
          method_id: id,
          kind: ref.kind,
          created_by_user_id: auth.userId,
          ...row,
        })
        .select("*")
        .single();
      if (error || !data) dbError(error, "attach the material");
      await audit("method.reference_added", id, { kind: ref.kind, source: row.source_type });
      return toReference(data);
    },
    async removeReference(id, referenceId) {
      await auth.db
        .from("method_references")
        .delete()
        .eq("workspace_id", auth.workspaceId)
        .eq("method_id", id)
        .eq("id", referenceId);
      await audit("method.reference_removed", id);
    },
    spaces: () => methodSpaces(auth),
  };
}

/** Active Spaces and Sections, with their paths (for scope). */
export async function methodSpaces(auth: AuthContext): Promise<SpaceRef[]> {
  const { data } = await auth.db
    .from("knowledge_spaces")
    .select("id, name, parent_space_id")
    .eq("workspace_id", auth.workspaceId)
    .eq("status", "active");
  const rows = data ?? [];
  const names = new Map(rows.map((r) => [r.id, r.name]));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    parentId: r.parent_space_id,
    path: r.parent_space_id ? `${names.get(r.parent_space_id) ?? ""} › ${r.name}` : r.name,
  }));
}

/** For the chat turn: the index and the Spaces (never blocks a turn). */
export async function methodsForTurn(
  auth: AuthContext,
): Promise<{ index: MethodSummary[]; spaces: SpaceRef[] }> {
  try {
    const [index, spaces] = await Promise.all([methodStore(auth).index(), methodSpaces(auth)]);
    return { index, spaces };
  } catch (error) {
    logger.warn("methods.load_failed", {
      code: error instanceof AppError ? error.code : "UNKNOWN",
    });
    return { index: [], spaces: [] };
  }
}

/** The execution trace (ADR-040 §P): which Method a run followed, and how it went. */
export async function recordMethodUse(
  auth: AuthContext,
  use: {
    method: Pick<MethodSummary, "id" | "version" | "spaceId">;
    scope: MethodScope;
    origin: "chat" | "voice" | "schedule";
    reason: string;
    aiRunId?: string | null;
    scheduleId?: string | null;
    tools?: string[];
    status: "completed" | "failed";
  },
) {
  const { error } = await auth.db.from("method_uses").insert({
    workspace_id: auth.workspaceId,
    user_id: auth.userId,
    method_id: use.method.id,
    method_version: use.method.version,
    scope: use.scope,
    origin: use.origin,
    reason: use.reason.slice(0, 300),
    ai_run_id: use.aiRunId ?? null,
    schedule_id: use.scheduleId ?? null,
    tools: [...new Set(use.tools ?? [])].slice(0, 40),
    status: use.status,
  });
  if (error) logger.warn("method.use_not_recorded", { cause: error.message });
  logger.info("method.used", {
    origin: use.origin,
    scope: use.scope,
    version: use.method.version,
    status: use.status,
    tools: use.tools?.length ?? 0,
  });
}

// ── Pages ────────────────────────────────────────────────────────────────────

export interface MethodCard extends MethodSummary {
  status: Method["status"];
  scope: MethodScope;
  scopeLabel: string;
}

/** Methods for a page: those of one Space (and its Sections), or all of them. */
export async function listMethodCards(
  auth: AuthContext,
  filter: { spaceId?: string } = {},
): Promise<{ methods: MethodCard[]; spaces: SpaceRef[] }> {
  const [all, spaces] = await Promise.all([methodStore(auth).list(), methodSpaces(auth)]);
  const parents = new Map(spaces.map((s) => [s.id, s.parentId]));
  const inSpace = (id: string | null) =>
    !filter.spaceId || id === filter.spaceId || (id !== null && parents.get(id) === filter.spaceId);
  return {
    spaces,
    methods: all
      .filter((m) => inSpace(m.spaceId))
      .map((m) => ({
        ...m,
        scope: scopeOf(m.spaceId, parents),
        scopeLabel: scopeLabel(m.spaceId, spaces),
      })),
  };
}

export type MethodDetail = Awaited<ReturnType<typeof methodDetail>>;

export async function methodDetail(auth: AuthContext, id: string) {
  const st = methodStore(auth);
  const [method, versions, references] = await Promise.all([
    st.get(id),
    st.versions(id),
    st.references(id),
  ]);
  return {
    method,
    // The list shows what changed and when; old contents load only when restored.
    versions: versions.map((v) => ({
      version: v.version,
      changeSummary: v.changeSummary,
      changeSource: v.changeSource,
      createdAt: v.createdAt,
    })),
    references: references.map((r) => ({
      ...r,
      content: r.content ? r.content.slice(0, 600) : null,
    })),
  };
}

export async function exportMethod(auth: AuthContext, id: string) {
  const st = methodStore(auth);
  const [m, refs, spaces] = await Promise.all([st.get(id), st.references(id), methodSpaces(auth)]);
  return {
    fileName: `${m.name.replace(/[\\/:*?"<>|]+/g, " ").trim() || "method"}.md`,
    markdown: toSkillMarkdown({
      ...m,
      scope: scopeLabel(m.spaceId, spaces),
      references: refs.map((r) => ({ kind: r.kind, title: r.title })),
    }),
  };
}

export async function importMethod(
  auth: AuthContext,
  input: { text: string; fileName?: string; spaceId: string | null },
): Promise<Method> {
  if (input.text.length > 100_000)
    throw new AppError("VALIDATION_ERROR", "That file is too large to be a Method");
  const parsed = parseSkillMarkdown(input.text, input.fileName);
  return methodStore(auth).create(
    normalizeMethod({ ...parsed, spaceId: input.spaceId }, { generated: false }),
    {
      source: "import",
      summary: auth.profile.locale === "es" ? "Importado" : "Imported",
      ref: {},
    },
  );
}

/** A Knowledge document's current text (to offer and use it as a Method). */
export async function knowledgeItemText(auth: AuthContext, itemId: string) {
  const { data: item } = await auth.db
    .from("knowledge_items")
    .select("id, title, space_id, current_version_id")
    .eq("workspace_id", auth.workspaceId)
    .eq("id", itemId)
    .maybeSingle();
  if (!item?.current_version_id) return null;
  const { data: version } = await auth.db
    .from("knowledge_versions")
    .select("extracted_text")
    .eq("workspace_id", auth.workspaceId)
    .eq("id", item.current_version_id)
    .maybeSingle();
  let text = version?.extracted_text ?? "";
  if (!text) {
    const { data: chunks } = await auth.db
      .from("knowledge_chunks")
      .select("content")
      .eq("workspace_id", auth.workspaceId)
      .eq("version_id", item.current_version_id)
      .order("chunk_index")
      .limit(80);
    text = (chunks ?? []).map((c) => c.content).join("\n\n");
  }
  return { title: item.title, spaceId: item.space_id, text: text.slice(0, 60_000) };
}

// ── "Contale a ELISE cómo querés que lo haga" (ADR-040 §J2) ───────────────────

const DRAFT_INSTRUCTIONS = `You turn a user's description of how they want a kind of work done into a reusable Method for their assistant ELISE.
Return only JSON: {"name": string, "description": string, "purpose"?: string, "whenToUse"?: string, "steps"?: string[], "checks"?: string[], "output"?: string, "mistakes"?: string[], "hints"?: string[]}.
- name: short, an action ("Crear propuesta comercial"). description: one line, what kind of work it's for.
- steps: the procedure in order, as reusable instructions. Keep the user's own rules and wording.
- Never add facts about clients, prices or people (that is Knowledge), dates or one-off details. Never invent steps the user didn't imply.
- hints: 3–8 words a request for this work would use, in the user's language and in English.
- Write in the user's language.`;

export interface MethodDraft {
  name: string;
  description: string;
  instructions: string;
  hints: string[];
}

/**
 * Structures free text into a Method for the user to review — nothing is saved here. Without AI
 * (or with an unusable answer) the user's text becomes the instructions as is.
 */
export async function draftMethod(auth: AuthContext, text: string): Promise<MethodDraft> {
  const locale = auth.profile.locale;
  const fallback = (): MethodDraft => {
    const first = text.trim().split(/[.\n]/)[0]!.trim();
    return {
      name: first.slice(0, 60) || (locale === "es" ? "Nuevo método" : "New method"),
      description: first.slice(0, METHOD_LIMITS.description),
      instructions: text.trim().slice(0, METHOD_LIMITS.instructions),
      hints: [],
    };
  };
  let out = "";
  try {
    for await (const event of getAIProvider().streamTurn({
      instructions: DRAFT_INSTRUCTIONS,
      input: [{ type: "message", role: "user", content: text.slice(0, 8000) }],
      tools: [],
      ...MODEL_POLICY.method_draft,
    })) {
      if (event.type === "text_delta") out += event.delta;
    }
    const raw = JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1)) as Record<
      string,
      unknown
    >;
    const str = (k: string) => (typeof raw[k] === "string" ? (raw[k] as string) : undefined);
    const arr = (k: string) =>
      Array.isArray(raw[k])
        ? ((raw[k] as unknown[]).filter((x) => typeof x === "string") as string[])
        : undefined;
    const instructions = composeInstructions(
      {
        purpose: str("purpose"),
        whenToUse: str("whenToUse"),
        steps: arr("steps"),
        checks: arr("checks"),
        output: str("output"),
        mistakes: arr("mistakes"),
      },
      locale,
    );
    if (!str("name") || !instructions) return fallback();
    return {
      name: str("name")!.slice(0, METHOD_LIMITS.name),
      description: (str("description") ?? str("name")!).slice(0, METHOD_LIMITS.description),
      instructions,
      hints: arr("hints") ?? [],
    };
  } catch (error) {
    logger.warn("method.draft_failed", {
      code: error instanceof AppError ? error.code : "UNKNOWN",
    });
    return fallback();
  }
}

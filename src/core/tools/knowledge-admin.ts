import { z } from "zod";

import type { ToolDefinition, ToolRunEnv } from "../agents/tools";
import { clip } from "../capabilities/email";
import { AppError } from "../errors";
import { matchKey } from "../history/links";
import type { SpaceOverview } from "../knowledge/admin";

/**
 * Knowledge administration tools (ADR-035): ELISE inspects and organizes the user's Knowledge —
 * Spaces, Sections, sources, chat attachments saved into it — through typed operations with the
 * same checks as the Knowledge UI. Structure questions ("¿qué tengo cargado en X?") are answered
 * from this metadata, never from semantic search. Archiving and removing always ask first.
 */

const km = (env: ToolRunEnv) => env.providers.get("knowledge", env.binding);
/** Summaries the user reads (approval cards, activity) speak their language. */
const es = (env: ToolRunEnv) => env.ctx.locale === "es";
const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

const spaceRef = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .describe('A Space or Section by name ("Francés", "Francés › Gramática") or id.');

/** Resolves a Space/Section the user named; ambiguity is a question, not a guess. */
async function resolveSpace(env: ToolRunEnv, ref: string): Promise<SpaceOverview> {
  const spaces = await km(env).listSpaces();
  const byId = spaces.find((s) => s.id === ref);
  if (byId) return byId;
  const wanted = matchKey(ref);
  const keys = (s: SpaceOverview) => [s.name, s.path].map(matchKey);
  const exact = spaces.filter((s) => keys(s).includes(wanted));
  const found = exact.length
    ? exact
    : wanted.length >= 3
      ? spaces.filter((s) => keys(s).some((k) => k.includes(wanted)))
      : [];
  if (found.length === 1) return found[0]!;
  if (!found.length)
    throw new AppError(
      "NOT_FOUND",
      spaces.length
        ? `No Space or Section called "${ref}". They are: ${spaces.map((s) => s.path).join("; ")}`
        : "There are no Knowledge Spaces yet",
      { recovery: "review" },
    );
  throw new AppError(
    "VALIDATION_ERROR",
    `"${ref}" matches several: ${found.map((s) => s.path).join("; ")}. Ask which one.`,
    { recovery: "review" },
  );
}

const counts = (s: SpaceOverview) => ({
  sections: s.sections,
  sources: s.sources,
  ready: s.documents.ready,
  processing: s.documents.processing,
  needsAttention: s.documents.attention,
});

export const listSpacesTool: ToolDefinition = {
  name: "knowledge.listSpaces",
  capability: "knowledge",
  operation: "listSpaces",
  description:
    '"¿Qué espacios de conocimiento tengo?": the user\'s Knowledge Spaces and Sections with what each is about (description, context) and how much is in it. Structure, not document content.',
  input: z.object({}).strict(),
  async describe() {
    return { summary: "List Knowledge Spaces" };
  },
  async run(_raw, env) {
    const spaces = await km(env).listSpaces();
    return {
      output: {
        count: spaces.length,
        spaces: spaces.map((s) => ({
          path: s.path,
          ...(s.description ? { description: clip(s.description, 300) } : {}),
          ...(s.context ? { context: clip(s.context, 300) } : {}),
          ...counts(s),
        })),
      },
    };
  },
};

const getSpaceInput = z.object({ space: spaceRef }).strict();

export const getSpaceTool: ToolDefinition = {
  name: "knowledge.getSpace",
  capability: "knowledge",
  operation: "getSpace",
  description:
    '"¿Qué tengo cargado en X?", "¿qué es X?", "¿por qué no aparece este libro?", "¿qué está conectado de Drive?": one Space or Section — its description and context (the user\'s own words about what it is), its Sections, documents with their status (ready, processing, needs attention and why) and connected sources. A Section also gets its parent Space\'s description and general documents. Use it for structure and status; knowledge.search for what documents say.',
  input: getSpaceInput,
  async describe() {
    return { summary: "Open Space" };
  },
  async run(raw, env) {
    const s = await resolveSpace(env, getSpaceInput.parse(raw).space);
    const c = await km(env).contents(s.id);
    return {
      output: {
        path: s.path,
        // User-authored metadata: what this Space/Section is (not document evidence).
        metadata: {
          sourceKind: s.parentId ? "knowledge_section_metadata" : "knowledge_space_metadata",
          description: s.description,
          context: s.context,
          ...(c.parent
            ? {
                parentSpace: {
                  name: c.parent.name,
                  description: c.parent.description,
                  context: c.parent.context,
                },
                inheritance:
                  "This Section also uses its parent Space's general documents and context.",
              }
            : {}),
        },
        sections: c.sections.map((x) => ({ name: x.name, description: x.description })),
        documents: c.documents.slice(0, 60).map((d) => ({
          id: d.id,
          title: d.title,
          source: d.type,
          status: d.status,
          ...(d.detail ? { detail: d.detail } : {}),
        })),
        ...(c.documents.length > 60 ? { moreDocuments: c.documents.length - 60 } : {}),
        connectedSources: c.sources,
        instructions:
          "Answer structure questions from this. When the description/context answers what the Space is, say so (it's what the user wrote about it). Never claim document contents from it.",
      },
    };
  },
};

const createInput = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z
      .string()
      .trim()
      .max(1000)
      .optional()
      .describe("What it's about, in one sentence (from the conversation when it's clear)."),
    parent: spaceRef
      .optional()
      .describe('Creates a Section inside this Space ("adentro de Francés").'),
  })
  .strict();

export const createSpaceTool: ToolDefinition = {
  name: "knowledge.createSpace",
  capability: "knowledge",
  operation: "createSpace",
  description:
    '"Creame un espacio para aprender francés" (a Space) or "adentro agregá una sección de Gramática" (a Section: pass parent). Icon and color get defaults; never ask for them, and Sections have no type.',
  input: createInput,
  async describe(raw, env) {
    const q = createInput.parse(raw);
    return {
      summary: es(env)
        ? q.parent
          ? `Crear la sección “${q.name}”`
          : `Crear el espacio “${q.name}”`
        : q.parent
          ? `Create Section “${q.name}”`
          : `Create Space “${q.name}”`,
    };
  },
  async run(raw, env) {
    const q = createInput.parse(raw);
    const parent = q.parent ? await resolveSpace(env, q.parent) : null;
    if (parent?.parentId)
      throw new AppError(
        "VALIDATION_ERROR",
        "Sections live directly inside a Space (one level). Create it in the parent Space.",
        { recovery: "review" },
      );
    const { id, section } = await km(env).createSpace({
      name: q.name,
      description: q.description ?? null,
      parentId: parent?.id ?? null,
    });
    return {
      output: {
        created: parent ? `${parent.name} › ${q.name}` : q.name,
        section,
        instructions: "Confirm briefly what was created and where.",
      },
      target: { type: "knowledge_space", id },
    };
  },
};

const updateInput = z
  .object({
    space: spaceRef,
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(1000).optional(),
    context: z.string().trim().max(4000).optional().describe("Replaces the whole context."),
    addToContext: z
      .string()
      .trim()
      .min(1)
      .max(1000)
      .optional()
      .describe('Adds a line to the context ("el examen final es en diciembre"). Only when asked.'),
  })
  .strict();

export const updateSpaceTool: ToolDefinition = {
  name: "knowledge.updateSpace",
  capability: "knowledge",
  operation: "updateSpace",
  description:
    'Rename a Space/Section or change its description or context ("Renombrá Álgebra a Álgebra Lineal", "decile a esta sección que el final es en diciembre"). Effective immediately for ELISE.',
  input: updateInput,
  async describe(raw, env) {
    const space = updateInput.parse(raw).space;
    return { summary: es(env) ? `Actualizar “${space}”` : `Update “${space}”` };
  },
  async run(raw, env) {
    const q = updateInput.parse(raw);
    const s = await resolveSpace(env, q.space);
    const context =
      q.addToContext !== undefined
        ? [s.context?.trim(), q.addToContext].filter(Boolean).join("\n")
        : q.context;
    await km(env).updateSpace(s.id, {
      ...(q.name !== undefined ? { name: q.name } : {}),
      ...(q.description !== undefined ? { description: q.description || null } : {}),
      ...(context !== undefined ? { context: context || null } : {}),
    });
    return {
      output: {
        updated: q.name ? `${s.path} → ${q.name}` : s.path,
        changed: [
          q.name !== undefined && "name",
          q.description !== undefined && "description",
          context !== undefined && "context",
        ].filter(Boolean),
      },
      target: { type: "knowledge_space", id: s.id },
    };
  },
};

const archiveInput = z.object({ space: spaceRef }).strict();

export const archiveSpaceTool: ToolDefinition = {
  name: "knowledge.archiveSpace",
  capability: "knowledge",
  operation: "archiveSpace",
  description:
    "Archive a Space or Section (it and its Sections leave Knowledge; sources stop syncing). Always needs the user's approval: say it's waiting for it, never that it's done.",
  input: archiveInput,
  async describe(raw, env) {
    const s = await resolveSpace(env, archiveInput.parse(raw).space);
    const docs = s.documents.ready + s.documents.processing + s.documents.attention;
    return {
      summary: es(env)
        ? `Archivar “${s.path}” (${n(docs, "documento", "documentos")}${s.sections ? `, ${n(s.sections, "sección", "secciones")}` : ""})`
        : `Archive “${s.path}” (${n(docs, "document", "documents")}${s.sections ? `, ${n(s.sections, "Section", "Sections")}` : ""})`,
      target: { type: "knowledge_space", id: s.id },
    };
  },
  async run(raw, env) {
    const s = await resolveSpace(env, archiveInput.parse(raw).space);
    await km(env).archiveSpace(s.id);
    return { output: { archived: s.path }, target: { type: "knowledge_space", id: s.id } };
  },
};

const documentId = z.uuid().describe("A document id from knowledge.getSpace.");
const moveInput = z
  .object({
    document: documentId,
    to: spaceRef.describe(
      "The Section to move it to, or the parent Space to make it a general source of the Space.",
    ),
  })
  .strict();

export const moveDocumentTool: ToolDefinition = {
  name: "knowledge.moveDocument",
  capability: "knowledge",
  operation: "moveDocument",
  description:
    '"Mové este PDF a Vocabulario", "dejalo como fuente general del espacio": moves an uploaded document between a Space and its Sections. Nothing is copied or read again.',
  input: moveInput,
  async describe() {
    return { summary: "Move document" };
  },
  async run(raw, env) {
    const q = moveInput.parse(raw);
    const to = await resolveSpace(env, q.to);
    await km(env).moveDocument(q.document, to.id);
    return {
      output: { moved: q.document, to: to.path, general: !to.parentId },
      target: { type: "knowledge_item", id: q.document },
    };
  },
};

const removeInput = z
  .object({
    document: documentId.optional(),
    source: z.uuid().optional().describe("A connected source id (Drive folder, Notion page)."),
  })
  .strict()
  .refine((q) => Boolean(q.document) !== Boolean(q.source), "Exactly one of document or source");

export const removeKnowledgeTool: ToolDefinition = {
  name: "knowledge.remove",
  capability: "knowledge",
  operation: "remove",
  description:
    "Remove a document, or disconnect a connected source (its files in Drive/Notion are untouched; what ELISE indexed is deleted). Always needs approval.",
  input: removeInput,
  async describe(raw, env) {
    const q = removeInput.parse(raw);
    return {
      summary: q.document
        ? es(env)
          ? "Quitar un documento de Conocimiento"
          : "Remove a document from Knowledge"
        : es(env)
          ? "Desconectar una fuente de Conocimiento"
          : "Disconnect a Knowledge source",
      target: q.document
        ? { type: "knowledge_item", id: q.document }
        : { type: "knowledge_source", id: q.source! },
    };
  },
  async run(raw, env) {
    const q = removeInput.parse(raw);
    if (q.document) await km(env).removeDocument(q.document);
    else await km(env).removeSource(q.source!);
    return {
      output: { removed: q.document ?? q.source },
      target: q.document
        ? { type: "knowledge_item", id: q.document }
        : { type: "knowledge_source", id: q.source! },
    };
  },
};

const retryInput = z
  .object({
    documents: z.array(documentId).max(50).optional(),
    failed: z
      .boolean()
      .optional()
      .describe('"Reintentá los que fallaron": every document that needs attention (in `space`).'),
    space: spaceRef.optional(),
  })
  .strict();

export const retryKnowledgeTool: ToolDefinition = {
  name: "knowledge.retry",
  capability: "knowledge",
  operation: "retry",
  description:
    "Process documents again (scanned PDFs are read with text recognition now): specific ones, or every one that needs attention. Safe to repeat.",
  input: retryInput,
  async describe() {
    return { summary: "Retry documents" };
  },
  async run(raw, env) {
    const q = retryInput.parse(raw);
    let ids = q.documents ?? [];
    if (q.failed) {
      // A Space includes its Sections: "los que fallaron en Acme" covers Acme › Onboarding too.
      const all = await km(env).listSpaces();
      const root = q.space ? await resolveSpace(env, q.space) : null;
      const spaces = all.filter(
        (s) => s.documents.attention && (!root || s.id === root.id || s.parentId === root.id),
      );
      for (const s of spaces) {
        const c = await km(env).contents(s.id);
        ids.push(
          ...c.documents
            .filter((d) => d.status === "needs_attention" || d.status === "failed")
            .map((d) => d.id),
        );
      }
      ids = [...new Set(ids)].slice(0, 50);
    }
    if (!ids.length) return { output: { retried: 0, note: "Nothing needed retrying." } };
    const retried = await km(env).retryDocuments(ids);
    return {
      output: {
        retried,
        instructions:
          "Say how many are being processed again; they appear as Ready when done (status in knowledge.getSpace).",
      },
    };
  },
};

const syncInput = z.object({ source: z.uuid() }).strict();

export const syncSourceTool: ToolDefinition = {
  name: "knowledge.syncSource",
  capability: "knowledge",
  operation: "syncSource",
  description:
    '"Volvé a sincronizar esta carpeta": syncs a connected Drive or Notion source now (id from knowledge.getSpace).',
  input: syncInput,
  async describe() {
    return { summary: "Sync source" };
  },
  async run(raw, env) {
    const status = await km(env).syncSource(syncInput.parse(raw).source);
    return { output: { status } };
  },
};

const saveInput = z
  .object({
    attachments: z
      .array(z.uuid())
      .min(1)
      .max(8)
      .describe('Attachment ids from the user\'s message ("attachment …"); never guessed.'),
    space: spaceRef,
  })
  .strict();

export const saveAttachmentTool: ToolDefinition = {
  name: "knowledge.saveAttachment",
  capability: "knowledge",
  operation: "saveAttachment",
  description:
    '"Guardá este PDF en Derecho", "los dos archivos agregalos a Gramática": saves files the user attached in this conversation into a Space or Section. No re-upload; what was already read (OCR included) is reused. Only when the user asks to keep them.',
  input: saveInput,
  async describe(raw, env) {
    const q = saveInput.parse(raw);
    const files = q.attachments.length;
    return {
      summary: es(env)
        ? `Guardar ${n(files, "archivo", "archivos")} en “${q.space}”`
        : `Save ${n(files, "file", "files")} to “${q.space}”`,
    };
  },
  async run(raw, env) {
    const q = saveInput.parse(raw);
    const to = await resolveSpace(env, q.space);
    const saved = [];
    for (const id of q.attachments) saved.push(await km(env).saveAttachment(id, to.id));
    return {
      output: {
        saved: saved.map((s) => s.title),
        to: to.path,
        instructions:
          "Say they're saved and being processed (they become searchable when ready). Don't claim they're ready yet.",
      },
      target: { type: "knowledge_item", id: saved[0]!.itemId },
    };
  },
};

export const KNOWLEDGE_ADMIN_TOOLS = [
  listSpacesTool,
  getSpaceTool,
  createSpaceTool,
  updateSpaceTool,
  archiveSpaceTool,
  moveDocumentTool,
  removeKnowledgeTool,
  retryKnowledgeTool,
  syncSourceTool,
  saveAttachmentTool,
];

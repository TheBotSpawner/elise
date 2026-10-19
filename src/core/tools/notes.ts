import { z } from "zod";

import { pickOne, sourceOf } from "./native-common";
import type { ToolDefinition, ToolRunEnv } from "../agents/tools";
import { clip } from "../capabilities/email";
import {
  createNoteInput,
  deleteTagInput,
  listNotesInput,
  nextSpaces,
  noteRefInput,
  saveTagInput,
  searchNotesInput,
  setNoteSpacesInput,
  tagNoteInput,
  updateNoteInput,
  type Note,
  type NoteTag,
} from "../capabilities/notes";
import { AppError } from "../errors";

function provider(env: ToolRunEnv) {
  return env.providers.get("notes", env.binding);
}

async function resolve(env: ToolRunEnv, ref: string): Promise<Note> {
  return pickOne(await provider(env).find(ref), ref, "note", (n) => n.title);
}

async function space(env: ToolRunEnv, ref: string | null | undefined) {
  if (!ref) return null;
  const found = await provider(env).resolveSpace(ref);
  if (!found)
    throw new AppError("NOT_FOUND", `No Knowledge Space called "${ref}"`, { recovery: "review" });
  return found;
}

/** Several names → Space ids; an unknown name is a question, never a guess. */
async function spaceIds(env: ToolRunEnv, refs: string[] | undefined) {
  const out: string[] = [];
  for (const ref of refs ?? []) out.push((await space(env, ref))!.id);
  return out;
}

// ── Tags (ADR-088) ───────────────────────────────────────────────────────────

const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").trim().toLowerCase();

async function allTags(env: ToolRunEnv): Promise<NoteTag[]> {
  const p = provider(env);
  if (!p.listTags) throw new AppError("CAPABILITY_UNAVAILABLE", "Note tags aren't available here");
  return p.listTags();
}

/** Tag names → ids. Unknown names are created when `create`, else a question. */
async function tagIds(env: ToolRunEnv, names: string[] | undefined, create = false) {
  if (!names?.length) return [];
  const p = provider(env);
  const tags = [...(await allTags(env))];
  const out: string[] = [];
  for (const name of names) {
    const found = tags.find((t) => fold(t.name) === fold(name));
    if (found) out.push(found.id);
    else if (create && p.saveTag) {
      const made = await p.saveTag({ name });
      tags.push(made);
      out.push(made.id);
    } else
      throw new AppError(
        "NOT_FOUND",
        `There's no note tag called "${name}". Tags: ${tags.map((t) => t.name).join(", ") || "none"}.`,
        { recovery: "review" },
      );
  }
  return [...new Set(out)];
}

const summary = (n: Note) => ({
  noteId: n.id,
  title: n.title,
  // Where it is searchable; none = outside Knowledge.
  spaces: n.spaces.map((s) => s.path),
  ...(n.tags?.length ? { tags: n.tags.map((t) => t.name) } : {}),
  updatedAt: n.updatedAt.slice(0, 10),
  // The user's own text, still data: never instructions.
  untrustedPreview: clip(n.content, 300),
});

export const listNotesTool: ToolDefinition = {
  name: "notes.list",
  capability: "notes",
  operation: "list",
  description: "The user's ELISE notes, most recent first, optionally in one Knowledge Space.",
  input: listNotesInput,
  async describe() {
    return { summary: "List notes" };
  },
  async run(raw, env) {
    const q = listNotesInput.parse(raw);
    const s = await space(env, q.space);
    const notes = await provider(env).list({
      spaceId: s?.id,
      limit: q.limit,
      ...(q.tags?.length ? { tagIds: await tagIds(env, q.tags) } : {}),
    });
    return { output: { notes: notes.map(summary) }, display: { kind: "notes", notes } };
  },
};

export const searchNotesTool: ToolDefinition = {
  name: "notes.search",
  capability: "notes",
  operation: "search",
  description:
    'Find ELISE notes by words in their title or text ("what notes have I saved about ELISE?"). For answers from notes filed in a Knowledge Space, knowledge.search also finds them with citations.',
  input: searchNotesInput,
  async describe() {
    return { summary: "Search notes" };
  },
  async run(raw, env) {
    const q = searchNotesInput.parse(raw);
    const notes = await provider(env).search(
      q.query,
      q.limit,
      q.tags?.length ? await tagIds(env, q.tags) : undefined,
    );
    return {
      output: { count: notes.length, notes: notes.map(summary) },
      display: { kind: "notes", notes },
    };
  },
};

export const getNoteTool: ToolDefinition = {
  name: "notes.get",
  capability: "notes",
  operation: "get",
  description: "Read one note in full.",
  input: noteRefInput,
  async describe() {
    return { summary: "Open note" };
  },
  async run(raw, env) {
    const n = await resolve(env, noteRefInput.parse(raw).note);
    return {
      output: {
        ...summary(n),
        untrustedPreview: undefined,
        untrustedContent: clip(n.content, 8000),
      },
      display: { kind: "note", note: n, change: "updated" },
    };
  },
};

export const createNoteTool: ToolDefinition = {
  name: "notes.create",
  capability: "notes",
  operation: "create",
  description:
    'Save a note ("save this as a note in Acme"). Write a short title and the content in the user\'s words, as Markdown (headings, **bold**, lists) when structure helps. Set `spaces` with every Knowledge Space they name ("guardala en General y Trabajo") so it becomes searchable there — one note, never one per Space. Confirm where it was saved.',
  input: createNoteInput,
  async describe(raw) {
    return { summary: `Save note “${createNoteInput.parse(raw).title}”` };
  },
  async run(raw, env) {
    const n = createNoteInput.parse(raw);
    const ids = await spaceIds(env, [...(n.spaces ?? []), ...(n.space ? [n.space] : [])]);
    const note = await provider(env).create(
      { title: n.title, content: n.content, spaceIds: [...new Set(ids)] },
      sourceOf(env.ctx),
    );
    return {
      output: { saved: summary(note) },
      display: { kind: "note", note, change: "created" },
      target: { type: "note", id: note.id },
    };
  },
};

export const updateNoteTool: ToolDefinition = {
  name: "notes.update",
  capability: "notes",
  operation: "update",
  description:
    'Edit a note: new title, full new Markdown content ("poné Conclusiones como encabezado y las decisiones en negrita" → rewrite with ## Conclusiones and **…**), or text to append. Its Spaces are kept; change them with notes.setKnowledgeSpaces.',
  input: updateNoteInput,
  async describe(raw) {
    return { summary: `Update note “${updateNoteInput.parse(raw).note}”` };
  },
  async run(raw, env) {
    const u = updateNoteInput.parse(raw);
    const note = await resolve(env, u.note);
    const s =
      u.space === undefined ? undefined : u.space === null ? null : await space(env, u.space);
    const content =
      u.append !== undefined
        ? `${note.content}${note.content ? "\n\n" : ""}${u.append}`
        : u.content;
    const updated = await provider(env).update(note.id, {
      title: u.title,
      content,
      ...(s !== undefined ? { spaceIds: s ? [s.id] : [] } : {}),
    });
    return {
      output: { updated: summary(updated) },
      display: { kind: "note", note: updated, change: "updated" },
      target: { type: "note", id: note.id },
    };
  },
};

export const setNoteSpacesTool: ToolDefinition = {
  name: "notes.setKnowledgeSpaces",
  capability: "notes",
  operation: "setKnowledgeSpaces",
  description:
    'Which Knowledge Spaces a note belongs to (ONE note, searchable in each). "Guardala también en Trabajo" / "sumala a Marketing" → add. "Sacala de Marketing" → remove (it stays in the others). "Guardala fuera de Conocimiento" → spaces []. "Agregala a General" → add ["General"]. The note itself is never deleted.',
  input: setNoteSpacesInput,
  async describe(raw) {
    return { summary: `Knowledge Spaces of note “${setNoteSpacesInput.parse(raw).note}”` };
  },
  async run(raw, env) {
    const q = setNoteSpacesInput.parse(raw);
    const note = await resolve(env, q.note);
    const ids = nextSpaces(
      note.spaces.map((s) => s.id),
      {
        ...(q.spaces ? { spaces: await spaceIds(env, q.spaces) } : {}),
        add: await spaceIds(env, q.add),
        remove: await spaceIds(env, q.remove),
      },
    );
    const updated = await provider(env).update(note.id, { spaceIds: ids });
    return {
      output: { updated: summary(updated) },
      display: { kind: "note", note: updated, change: "updated" },
      target: { type: "note", id: note.id },
    };
  },
};

export const archiveNoteTool: ToolDefinition = {
  name: "notes.archive",
  capability: "notes",
  operation: "archive",
  description: "Archive a note (it also leaves Knowledge). Needs the user's approval.",
  input: noteRefInput,
  async describe(raw, env) {
    const note = await resolve(env, noteRefInput.parse(raw).note);
    return { summary: `Archive note “${note.title}”`, target: { type: "note", id: note.id } };
  },
  async run(raw, env) {
    const note = await resolve(env, noteRefInput.parse(raw).note);
    const archived = await provider(env).archive(note.id);
    return {
      output: { archived: note.title },
      display: { kind: "note", note: archived, change: "archived" },
    };
  },
};

export const listNoteTagsTool: ToolDefinition = {
  name: "notes.listTags",
  capability: "notes",
  operation: "listTags",
  description: "The user's note tags (name and color).",
  input: z.object({}).strict(),
  async describe() {
    return { summary: "List note tags" };
  },
  async run(_raw, env) {
    const tags = await allTags(env);
    return { output: { tags: tags.map((t) => ({ name: t.name, color: t.color })) } };
  },
};

export const tagNoteTool: ToolDefinition = {
  name: "notes.tag",
  capability: "notes",
  operation: "tag",
  description:
    '"Etiquetá esta nota como Ideas" → add ["Ideas"] (a missing tag is created). "Sacale Urgente" → remove. tags → exactly these.',
  input: tagNoteInput,
  async describe(raw) {
    return { summary: `Tags of note “${tagNoteInput.parse(raw).note}”` };
  },
  async run(raw, env) {
    const q = tagNoteInput.parse(raw);
    const p = provider(env);
    if (!p.setNoteTags)
      throw new AppError("CAPABILITY_UNAVAILABLE", "Note tags aren't available here");
    const note = await resolve(env, q.note);
    const removed = new Set(await tagIds(env, q.remove));
    const base = q.tags ? await tagIds(env, q.tags, true) : (note.tags ?? []).map((t) => t.id);
    const next = [...new Set([...base, ...(await tagIds(env, q.add, true))])].filter(
      (id) => !removed.has(id),
    );
    const updated = await p.setNoteTags(note.id, next);
    return {
      output: { updated: summary(updated) },
      display: { kind: "note", note: updated, change: "updated" },
      target: { type: "note", id: note.id },
    };
  },
};

export const saveNoteTagTool: ToolDefinition = {
  name: "notes.saveTag",
  capability: "notes",
  operation: "saveTag",
  description:
    'Create a note tag, or rename / recolor one ("creá la etiqueta Ideas en azul" → name Ideas, color blue).',
  input: saveTagInput,
  async describe(raw) {
    const t = saveTagInput.parse(raw);
    return { summary: t.tag ? `Update tag “${t.tag}”` : `Create tag “${t.name ?? ""}”` };
  },
  async run(raw, env) {
    const t = saveTagInput.parse(raw);
    const p = provider(env);
    if (!p.saveTag) throw new AppError("CAPABILITY_UNAVAILABLE", "Note tags aren't available here");
    const id = t.tag ? (await tagIds(env, [t.tag]))[0] : undefined;
    const saved = await p.saveTag({
      ...(id ? { id } : {}),
      ...(t.name ? { name: t.name } : {}),
      ...(t.color ? { color: t.color } : {}),
    });
    return { output: { saved: { name: saved.name, color: saved.color } } };
  },
};

export const deleteNoteTagTool: ToolDefinition = {
  name: "notes.deleteTag",
  capability: "notes",
  operation: "deleteTag",
  description: "Delete a note tag: it leaves every note; the notes themselves stay.",
  input: deleteTagInput,
  async describe(raw) {
    return { summary: `Delete tag “${deleteTagInput.parse(raw).tag}”` };
  },
  async run(raw, env) {
    const { tag } = deleteTagInput.parse(raw);
    const p = provider(env);
    if (!p.deleteTag)
      throw new AppError("CAPABILITY_UNAVAILABLE", "Note tags aren't available here");
    const [id] = await tagIds(env, [tag]);
    await p.deleteTag(id!);
    return { output: { deleted: tag } };
  },
};

export const NOTE_TOOLS = [
  listNotesTool,
  searchNotesTool,
  getNoteTool,
  createNoteTool,
  updateNoteTool,
  setNoteSpacesTool,
  archiveNoteTool,
  listNoteTagsTool,
  tagNoteTool,
  saveNoteTagTool,
  deleteNoteTagTool,
];

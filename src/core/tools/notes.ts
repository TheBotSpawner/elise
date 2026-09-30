import { pickOne, sourceOf } from "./native-common";
import type { ToolDefinition, ToolRunEnv } from "../agents/tools";
import { clip } from "../capabilities/email";
import {
  createNoteInput,
  listNotesInput,
  noteRefInput,
  searchNotesInput,
  updateNoteInput,
  type Note,
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

const summary = (n: Note) => ({
  noteId: n.id,
  title: n.title,
  ...(n.spaceName ? { space: n.spaceName } : {}),
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
    const notes = await provider(env).list({ spaceId: s?.id, limit: q.limit });
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
    const notes = await provider(env).search(q.query, q.limit);
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
    'Save a note ("save this as a note in Firbot"). Write a short title and the content in the user\'s words; set `space` when they name a Knowledge Space so it becomes searchable there. Confirm where it was saved.',
  input: createNoteInput,
  async describe(raw) {
    return { summary: `Save note “${createNoteInput.parse(raw).title}”` };
  },
  async run(raw, env) {
    const n = createNoteInput.parse(raw);
    const s = await space(env, n.space);
    const note = await provider(env).create(
      { title: n.title, content: n.content, spaceId: s?.id ?? null },
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
    "Edit a note: new title, full new content, text to append, or move it to another Space (null removes it from Knowledge).",
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
      ...(s !== undefined ? { spaceId: s?.id ?? null } : {}),
    });
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

export const NOTE_TOOLS = [
  listNotesTool,
  searchNotesTool,
  getNoteTool,
  createNoteTool,
  updateNoteTool,
  archiveNoteTool,
];

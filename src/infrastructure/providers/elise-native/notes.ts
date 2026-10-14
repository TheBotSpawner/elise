import type { EntrySource } from "@/core/capabilities/habits";
import type { Note, NotesProvider } from "@/core/capabilities/notes";
import { AppError } from "@/core/errors";
import { spacePaths } from "@/core/knowledge/model";
import type { NoteRow } from "@/infrastructure/supabase/database.types";
import type { ServerSupabase } from "@/infrastructure/supabase/server";

import { byNameOrId, check, notMigrated } from "./common";

export type NoteChange = (note: Note, archived: boolean, textChanged: boolean) => Promise<void>;

/**
 * ELISE Notes (Native provider). The note row is the only editable copy; its Spaces live in
 * `note_knowledge_spaces` (ADR-056) and `notes.space_id` mirrors the first one, so a database
 * before migration 043 still works with one Space. `onChange` keeps the note's single
 * Knowledge item in step.
 */
export class EliseNotesProvider implements NotesProvider {
  constructor(
    private readonly db: ServerSupabase,
    private readonly workspaceId: string,
    private readonly userId: string,
    private readonly onChange: NoteChange = async () => {},
  ) {}

  private async spaces() {
    const { data } = await this.db
      .from("knowledge_spaces")
      .select("*")
      .eq("workspace_id", this.workspaceId)
      .eq("status", "active");
    const general = new Set((data ?? []).filter((s) => s.kind === "general").map((s) => s.id));
    return spacePaths(
      (data ?? []).map((s) => ({ id: s.id, name: s.name, parentId: s.parent_space_id })),
    ).map((s) => ({ ...s, general: general.has(s.id) }));
  }

  /** Space ids per note, oldest membership first; null before migration 043. */
  private async memberships(noteIds: string[]): Promise<Map<string, string[]> | null> {
    if (!noteIds.length) return new Map();
    const { data, error } = await this.db
      .from("note_knowledge_spaces")
      .select("note_id, space_id, created_at")
      .eq("workspace_id", this.workspaceId)
      .in("note_id", noteIds)
      .order("created_at");
    if (error && notMigrated(error.code)) return null;
    check(error, "load the notes' Spaces");
    const out = new Map<string, string[]>();
    for (const m of data ?? []) out.set(m.note_id, [...(out.get(m.note_id) ?? []), m.space_id]);
    return out;
  }

  private async shape(rows: NoteRow[]): Promise<Note[]> {
    const [spaces, members] = await Promise.all([
      this.spaces(),
      this.memberships(rows.map((r) => r.id)),
    ]);
    const path = new Map(spaces.map((s) => [s.id, s.path]));
    return rows.map((r) => {
      const ids = members ? (members.get(r.id) ?? []) : r.space_id ? [r.space_id] : [];
      // A Space that was archived or deleted isn't shown.
      const own = ids.filter((id) => path.has(id)).map((id) => ({ id, path: path.get(id)! }));
      return {
        id: r.id,
        title: r.title,
        content: r.content,
        spaces: own,
        spaceId: own[0]?.id ?? null,
        spaceName: own[0]?.path ?? null,
        source: r.source,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      };
    });
  }

  async list({ spaceId, limit }: { spaceId?: string | null; limit: number }) {
    let q = this.db
      .from("notes")
      .select("*")
      .eq("workspace_id", this.workspaceId)
      .eq("status", "active")
      .order("updated_at", { ascending: false })
      .limit(limit);
    if (spaceId) {
      const { data, error } = await this.db
        .from("note_knowledge_spaces")
        .select("note_id")
        .eq("workspace_id", this.workspaceId)
        .eq("space_id", spaceId);
      q =
        error && notMigrated(error.code)
          ? q.eq("space_id", spaceId)
          : q.in(
              "id",
              (data ?? []).map((m) => m.note_id),
            );
    }
    const { data, error } = await q;
    check(error, "load notes");
    return this.shape(data ?? []);
  }

  async find(ref: string) {
    return byNameOrId(await this.list({ limit: 500 }), ref, (n) => n.title);
  }

  async get(id: string) {
    const { data } = await this.db
      .from("notes")
      .select("*")
      .eq("id", id)
      .eq("workspace_id", this.workspaceId)
      .maybeSingle();
    return data ? (await this.shape([data]))[0]! : null;
  }

  /**
   * Deterministic full-text search over title + content (OR of the words). The index tokenizes
   * on letters and digits, so Markdown marks ("**", "#", "-") never get in the way.
   */
  async search(query: string, limit: number) {
    const words = (query.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []).slice(0, 8);
    if (!words.length) return [];
    const { data, error } = await this.db
      .from("notes")
      .select("*")
      .eq("workspace_id", this.workspaceId)
      .eq("status", "active")
      .textSearch("fts", words.join(" | "), { config: "simple" })
      .order("updated_at", { ascending: false })
      .limit(limit);
    check(error, "search notes");
    return this.shape(data ?? []);
  }

  /**
   * Sets the note's Spaces exactly (no duplicates: one row per note and Space). Before 043 only
   * one Space can be kept, and asking for more says the database needs its update.
   */
  private async setSpaces(noteId: string, spaceIds: string[]) {
    const wanted = [...new Set(spaceIds)];
    const { data: current, error } = await this.db
      .from("note_knowledge_spaces")
      .select("space_id")
      .eq("workspace_id", this.workspaceId)
      .eq("note_id", noteId);
    if (error && notMigrated(error.code)) {
      if (wanted.length > 1)
        throw new AppError(
          "CAPABILITY_UNAVAILABLE",
          "This needs the latest ELISE database update",
          {
            recovery: "review",
          },
        );
    } else {
      check(error, "update the note's Spaces");
      const have = new Set((current ?? []).map((m) => m.space_id));
      const gone = [...have].filter((id) => !wanted.includes(id));
      if (gone.length)
        await this.db
          .from("note_knowledge_spaces")
          .delete()
          .eq("workspace_id", this.workspaceId)
          .eq("note_id", noteId)
          .in("space_id", gone);
      // One at a time, in order: the first stays the first (it is the note's home in Knowledge).
      for (const id of wanted.filter((x) => !have.has(x))) {
        const { error: failed } = await this.db
          .from("note_knowledge_spaces")
          .insert({ workspace_id: this.workspaceId, note_id: noteId, space_id: id });
        check(failed, "add the note to a Space");
      }
    }
    const first = (await this.memberships([noteId]))?.get(noteId)?.[0] ?? wanted[0] ?? null;
    await this.db
      .from("notes")
      .update({ space_id: first })
      .eq("id", noteId)
      .eq("workspace_id", this.workspaceId);
  }

  async create(n: { title: string; content: string; spaceIds: string[] }, source: EntrySource) {
    const { data, error } = await this.db
      .from("notes")
      .insert({
        workspace_id: this.workspaceId,
        title: n.title,
        content: n.content,
        space_id: n.spaceIds[0] ?? null,
        source,
        created_by_user_id: this.userId,
      })
      .select("*")
      .single();
    check(error, "save the note");
    if (n.spaceIds.length) await this.setSpaces(data!.id, n.spaceIds);
    const note = (await this.get(data!.id))!;
    await this.onChange(note, false, true);
    return note;
  }

  async update(id: string, p: { title?: string; content?: string; spaceIds?: string[] }) {
    const before = await this.get(id);
    if (!before) throw new AppError("NOT_FOUND", "Note not found");
    const fields = {
      ...(p.title !== undefined ? { title: p.title } : {}),
      ...(p.content !== undefined ? { content: p.content } : {}),
    };
    if (Object.keys(fields).length) {
      const { data, error } = await this.db
        .from("notes")
        .update(fields)
        .eq("id", id)
        .eq("workspace_id", this.workspaceId)
        .eq("status", "active")
        .select("id")
        .maybeSingle();
      check(error, "update the note");
      if (!data) throw new AppError("NOT_FOUND", "Note not found");
    }
    if (p.spaceIds !== undefined) await this.setSpaces(id, p.spaceIds);
    const note = (await this.get(id))!;
    // Only Spaces changed: Knowledge updates scope, it doesn't re-embed anything.
    await this.onChange(
      note,
      false,
      note.title !== before.title || note.content !== before.content,
    );
    return note;
  }

  async archive(id: string) {
    const { data } = await this.db
      .from("notes")
      .update({ status: "archived", archived_at: new Date().toISOString() })
      .eq("id", id)
      .eq("workspace_id", this.workspaceId)
      .select("*")
      .maybeSingle();
    if (!data) throw new AppError("NOT_FOUND", "Note not found");
    const note = (await this.shape([data]))[0]!;
    await this.onChange(note, true, false);
    return note;
  }

  async resolveSpace(ref: string) {
    const spaces = await this.spaces();
    // "Conocimiento general" / "General Knowledge" / "general": the special Space (ADR-047).
    if (/^(general knowledge|conocimiento general|general)$/i.test(ref.trim())) {
      const g = spaces.find((s) => s.general);
      if (g) return { id: g.id, path: g.path };
    }
    const match = byNameOrId(spaces, ref, (s) => s.name);
    const exactPath = spaces.filter((s) => s.path.toLowerCase() === ref.toLowerCase());
    const found = exactPath.length === 1 ? exactPath : match;
    return found.length === 1 ? { id: found[0]!.id, path: found[0]!.path } : null;
  }
}

import type { EntrySource } from "@/core/capabilities/habits";
import type { Note, NotesProvider } from "@/core/capabilities/notes";
import { AppError } from "@/core/errors";
import { spacePaths } from "@/core/knowledge/model";
import type { NoteRow } from "@/infrastructure/supabase/database.types";
import type { ServerSupabase } from "@/infrastructure/supabase/server";

import { byNameOrId, check } from "./common";

/**
 * ELISE Notes (Native provider). The note row is the only editable copy; `onChange` keeps its
 * Knowledge representation in step (index, re-index, or remove from Knowledge).
 */
export class EliseNotesProvider implements NotesProvider {
  constructor(
    private readonly db: ServerSupabase,
    private readonly workspaceId: string,
    private readonly userId: string,
    private readonly onChange: (note: Note, archived: boolean) => Promise<void> = async () => {},
  ) {}

  private async spaces() {
    const { data } = await this.db
      .from("knowledge_spaces")
      .select("id, name, parent_space_id")
      .eq("workspace_id", this.workspaceId)
      .eq("status", "active");
    return spacePaths(
      (data ?? []).map((s) => ({ id: s.id, name: s.name, parentId: s.parent_space_id })),
    );
  }

  private async shape(rows: NoteRow[]): Promise<Note[]> {
    const spaces = rows.some((r) => r.space_id) ? await this.spaces() : [];
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      content: r.content,
      spaceId: r.space_id,
      spaceName: spaces.find((s) => s.id === r.space_id)?.path ?? null,
      source: r.source,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  async list({ spaceId, limit }: { spaceId?: string | null; limit: number }) {
    let q = this.db
      .from("notes")
      .select("*")
      .eq("workspace_id", this.workspaceId)
      .eq("status", "active")
      .order("updated_at", { ascending: false })
      .limit(limit);
    if (spaceId) q = q.eq("space_id", spaceId);
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

  /** Deterministic full-text search over title + content (OR of the words). */
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

  async create(n: { title: string; content: string; spaceId: string | null }, source: EntrySource) {
    const { data, error } = await this.db
      .from("notes")
      .insert({
        workspace_id: this.workspaceId,
        title: n.title,
        content: n.content,
        space_id: n.spaceId,
        source,
        created_by_user_id: this.userId,
      })
      .select("*")
      .single();
    check(error, "save the note");
    const note = (await this.shape([data!]))[0]!;
    await this.onChange(note, false);
    return note;
  }

  async update(id: string, p: { title?: string; content?: string; spaceId?: string | null }) {
    const { data, error } = await this.db
      .from("notes")
      .update({
        ...(p.title !== undefined ? { title: p.title } : {}),
        ...(p.content !== undefined ? { content: p.content } : {}),
        ...(p.spaceId !== undefined ? { space_id: p.spaceId } : {}),
      })
      .eq("id", id)
      .eq("workspace_id", this.workspaceId)
      .eq("status", "active")
      .select("*")
      .maybeSingle();
    check(error, "update the note");
    if (!data) throw new AppError("NOT_FOUND", "Note not found");
    const note = (await this.shape([data]))[0]!;
    await this.onChange(note, false);
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
    await this.onChange(note, true);
    return note;
  }

  async resolveSpace(ref: string) {
    const spaces = await this.spaces();
    const match = byNameOrId(spaces, ref, (s) => s.name);
    const exactPath = spaces.filter((s) => s.path.toLowerCase() === ref.toLowerCase());
    const found = exactPath.length === 1 ? exactPath : match;
    return found.length === 1 ? { id: found[0]!.id, path: found[0]!.path } : null;
  }
}

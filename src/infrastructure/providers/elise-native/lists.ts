import type { EntrySource } from "@/core/capabilities/habits";
import type { ListItem, ListsProvider, NativeList } from "@/core/capabilities/lists";
import { AppError } from "@/core/errors";
import type { ListItemRow, ListRow } from "@/infrastructure/supabase/database.types";
import type { ServerSupabase } from "@/infrastructure/supabase/server";

import { byNameOrId, check } from "./common";

const toItem = (r: ListItemRow): ListItem => ({
  id: r.id,
  listId: r.list_id,
  content: r.content,
  checked: r.checked,
  position: Number(r.position),
  notes: r.notes,
});

/** ELISE Lists (Native provider): ordered, checkable items. */
export class EliseListsProvider implements ListsProvider {
  constructor(
    private readonly db: ServerSupabase,
    private readonly workspaceId: string,
    private readonly userId: string,
  ) {}

  private async rows() {
    const { data, error } = await this.db
      .from("lists")
      .select("*")
      .eq("workspace_id", this.workspaceId)
      .is("archived_at", null)
      .order("updated_at", { ascending: false });
    check(error, "load lists");
    return data ?? [];
  }

  private async items(listIds: string[]) {
    if (!listIds.length) return [];
    const { data, error } = await this.db
      .from("list_items")
      .select("*")
      .eq("workspace_id", this.workspaceId)
      .in("list_id", listIds)
      .is("archived_at", null)
      .order("position");
    check(error, "load items");
    return (data ?? []).map(toItem);
  }

  private shape(row: ListRow, items: ListItem[]): NativeList {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      updatedAt: row.updated_at,
      items: items.filter((i) => i.listId === row.id),
    };
  }

  async list() {
    const rows = await this.rows();
    const items = await this.items(rows.map((r) => r.id));
    return rows.map((r) => {
      const own = items.filter((i) => i.listId === r.id);
      return {
        id: r.id,
        name: r.name,
        description: r.description,
        updatedAt: r.updated_at,
        total: own.length,
        open: own.filter((i) => !i.checked).length,
      };
    });
  }

  async find(ref: string) {
    const rows = byNameOrId(await this.rows(), ref, (r) => r.name);
    const items = await this.items(rows.map((r) => r.id));
    return rows.map((r) => this.shape(r, items));
  }

  async get(id: string) {
    const { data } = await this.db
      .from("lists")
      .select("*")
      .eq("id", id)
      .eq("workspace_id", this.workspaceId)
      .is("archived_at", null)
      .maybeSingle();
    return data ? this.shape(data, await this.items([id])) : null;
  }

  async create(
    l: { name: string; description?: string | null; items?: string[] },
    source: EntrySource,
  ) {
    const { data, error } = await this.db
      .from("lists")
      .insert({
        workspace_id: this.workspaceId,
        name: l.name,
        description: l.description ?? null,
        source,
        created_by_user_id: this.userId,
      })
      .select("*")
      .single();
    check(error, "create the list");
    if (l.items?.length) await this.addItems(data!.id, l.items, source);
    return (await this.get(data!.id))!;
  }

  async rename(id: string, name: string) {
    const { error } = await this.db
      .from("lists")
      .update({ name })
      .eq("id", id)
      .eq("workspace_id", this.workspaceId);
    check(error, "rename the list");
    const list = await this.get(id);
    if (!list) throw new AppError("NOT_FOUND", "List not found");
    return list;
  }

  async archive(id: string) {
    const list = await this.get(id);
    if (!list) throw new AppError("NOT_FOUND", "List not found");
    await this.db
      .from("lists")
      .update({ status: "archived", archived_at: new Date().toISOString() })
      .eq("id", id)
      .eq("workspace_id", this.workspaceId);
    return list;
  }

  async addItems(listId: string, items: string[], source: EntrySource) {
    const { data: last } = await this.db
      .from("list_items")
      .select("position")
      .eq("workspace_id", this.workspaceId)
      .eq("list_id", listId)
      .order("position", { ascending: false })
      .limit(1)
      .maybeSingle();
    const start = Number(last?.position ?? 0);
    const { data, error } = await this.db
      .from("list_items")
      .insert(
        items.map((content, i) => ({
          workspace_id: this.workspaceId,
          list_id: listId,
          content,
          position: start + (i + 1) * 1024,
          source,
        })),
      )
      .select("*");
    check(error, "add the items");
    // Touch the list so "recent lists" reflects activity.
    await this.db
      .from("lists")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", listId)
      .eq("workspace_id", this.workspaceId);
    return (data ?? []).map(toItem);
  }

  async updateItem(
    itemId: string,
    p: { content?: string; checked?: boolean; notes?: string | null },
  ) {
    const { data, error } = await this.db
      .from("list_items")
      .update({
        ...(p.content !== undefined ? { content: p.content } : {}),
        ...(p.checked !== undefined ? { checked: p.checked } : {}),
        ...(p.notes !== undefined ? { notes: p.notes } : {}),
      })
      .eq("id", itemId)
      .eq("workspace_id", this.workspaceId)
      .select("*")
      .maybeSingle();
    check(error, "update the item");
    if (!data) throw new AppError("NOT_FOUND", "Item not found");
    return toItem(data);
  }

  async removeItem(itemId: string) {
    const { data } = await this.db
      .from("list_items")
      .update({ archived_at: new Date().toISOString() })
      .eq("id", itemId)
      .eq("workspace_id", this.workspaceId)
      .select("*")
      .maybeSingle();
    if (!data) throw new AppError("NOT_FOUND", "Item not found");
    return toItem(data);
  }

  async reorder(listId: string, itemIds: string[]) {
    const list = await this.get(listId);
    if (!list) throw new AppError("NOT_FOUND", "List not found");
    const order = [
      ...itemIds.filter((id) => list.items.some((i) => i.id === id)),
      ...list.items.map((i) => i.id).filter((id) => !itemIds.includes(id)),
    ];
    await Promise.all(
      order.map((id, i) =>
        this.db
          .from("list_items")
          .update({ position: (i + 1) * 1024 })
          .eq("id", id)
          .eq("workspace_id", this.workspaceId),
      ),
    );
    return (await this.get(listId))!;
  }
}

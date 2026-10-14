import type { EntrySource } from "@/core/capabilities/habits";
import {
  matchLists,
  type ListItem,
  type ListItemSort,
  type ListsProvider,
  type ListSummary,
  type NativeList,
} from "@/core/capabilities/lists";
import { AppError } from "@/core/errors";
import type { ListItemRow, ListRow } from "@/infrastructure/supabase/database.types";
import type { ServerSupabase } from "@/infrastructure/supabase/server";

import { check, notMigrated } from "./common";

const toItem = (r: ListItemRow, labels: string[] = []): ListItem => ({
  id: r.id,
  listId: r.list_id,
  content: r.content,
  checked: r.checked,
  position: Number(r.position),
  notes: r.notes,
  labels,
  checkedAt: r.checked_at ?? (r.checked ? r.updated_at : null),
  createdAt: r.created_at,
});

const norm = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();

/**
 * ELISE Lists (Native provider, ADR-051): ordered, checkable items in user-arranged columns.
 * Every query is scoped to the workspace (defense in depth on top of RLS). Columns added by
 * migration 038 (position, icon, item sort, checked_at, item labels) are used when present; a
 * database without them still lists and edits.
 */
export class EliseListsProvider implements ListsProvider {
  constructor(
    private readonly db: ServerSupabase,
    private readonly workspaceId: string,
    private readonly userId: string,
  ) {}

  private async rows(): Promise<ListRow[]> {
    const { data, error } = await this.db
      .from("lists")
      .select("*")
      .eq("workspace_id", this.workspaceId)
      .is("archived_at", null)
      .order("created_at", { ascending: true });
    check(error, "load lists");
    // Column order: the user's arrangement (038), else creation order.
    return [...(data ?? [])].sort(
      (a, b) =>
        (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER) ||
        a.created_at.localeCompare(b.created_at),
    );
  }

  private async items(listIds: string[]): Promise<ListItem[]> {
    if (!listIds.length) return [];
    const { data, error } = await this.db
      .from("list_items")
      .select("*")
      .eq("workspace_id", this.workspaceId)
      .in("list_id", listIds)
      .is("archived_at", null)
      .order("position");
    check(error, "load items");
    const rows = data ?? [];
    const labels = await this.itemLabels(rows.map((r) => r.id));
    return rows.map((r) => toItem(r, labels.get(r.id) ?? []));
  }

  /** Labels of these items in one read (none before migration 038). */
  private async itemLabels(itemIds: string[]): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    if (!itemIds.length) return out;
    const [assignments, labels] = await Promise.all([
      this.db
        .from("label_assignments")
        .select("label_id, list_item_id")
        .eq("workspace_id", this.workspaceId)
        .in("list_item_id", itemIds),
      this.db.from("labels").select("id, name").eq("workspace_id", this.workspaceId),
    ]);
    if (assignments.error || labels.error) return out; // not migrated: unlabelled
    const name = new Map((labels.data ?? []).map((l) => [l.id, l.name]));
    for (const a of assignments.data ?? []) {
      const n = name.get(a.label_id);
      if (n && a.list_item_id)
        out.set(a.list_item_id, [...(out.get(a.list_item_id) ?? []), n].sort());
    }
    return out;
  }

  private shape(row: ListRow, items: ListItem[]): NativeList {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      updatedAt: row.updated_at,
      position: row.position ?? undefined,
      icon: row.icon ?? null,
      itemSort: row.item_sort ?? "manual",
      items: items.filter((i) => i.listId === row.id),
    };
  }

  async list(): Promise<ListSummary[]> {
    return (await this.all()).map(({ items, ...l }) => ({
      ...l,
      total: items.length,
      open: items.filter((i) => !i.checked).length,
    }));
  }

  async all(): Promise<NativeList[]> {
    const rows = await this.rows();
    const items = await this.items(rows.map((r) => r.id));
    return rows.map((r) => this.shape(r, items));
  }

  async find(ref: string) {
    const rows = matchLists(await this.rows(), ref);
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

  private async nextListPosition(): Promise<number | null> {
    const rows = await this.rows();
    if (rows.length && rows.every((r) => r.position === undefined)) return null; // not migrated
    return Math.max(0, ...rows.map((r) => r.position ?? 0)) + 1024;
  }

  async create(
    l: { name: string; description?: string | null; icon?: string | null; items?: string[] },
    source: EntrySource,
  ) {
    const position = await this.nextListPosition();
    const base = {
      workspace_id: this.workspaceId,
      name: l.name,
      description: l.description ?? null,
      source,
      created_by_user_id: this.userId,
    };
    let { data, error } = await this.db
      .from("lists")
      .insert({
        ...base,
        ...(position !== null ? { position } : {}),
        ...(l.icon ? { icon: l.icon } : {}),
      })
      .select("*")
      .single();
    if (error && notMigrated(error.code))
      ({ data, error } = await this.db.from("lists").insert(base).select("*").single());
    check(error, "create the list");
    if (l.items?.length) await this.addItems(data!.id, l.items, source);
    return (await this.get(data!.id))!;
  }

  rename(id: string, name: string) {
    return this.update(id, { name });
  }

  async update(
    id: string,
    p: {
      name?: string;
      description?: string | null;
      icon?: string | null;
      itemSort?: ListItemSort;
    },
  ) {
    const patch = {
      ...(p.name !== undefined ? { name: p.name } : {}),
      ...(p.description !== undefined ? { description: p.description } : {}),
      ...(p.icon !== undefined ? { icon: p.icon || null } : {}),
      ...(p.itemSort !== undefined ? { item_sort: p.itemSort } : {}),
    };
    if (Object.keys(patch).length) {
      const { error } = await this.db
        .from("lists")
        .update(patch)
        .eq("id", id)
        .eq("workspace_id", this.workspaceId);
      if (error && notMigrated(error.code))
        throw new AppError(
          "CAPABILITY_UNAVAILABLE",
          "This needs the latest ELISE database update",
          {
            recovery: "review",
          },
        );
      check(error, "update the list");
    }
    const list = await this.get(id);
    if (!list) throw new AppError("NOT_FOUND", "List not found");
    return list;
  }

  async archive(id: string) {
    const list = await this.get(id);
    if (!list) throw new AppError("NOT_FOUND", "List not found");
    const { error } = await this.db
      .from("lists")
      .update({ status: "archived", archived_at: new Date().toISOString() })
      .eq("id", id)
      .eq("workspace_id", this.workspaceId);
    check(error, "delete the list");
    return list;
  }

  /** A copy to reuse (packing for the next trip): same items, all unchecked, same labels. */
  async duplicate(id: string, source: EntrySource) {
    const list = await this.get(id);
    if (!list) throw new AppError("NOT_FOUND", "List not found");
    const copy = await this.create(
      {
        name: `${list.name} (copia)`.slice(0, 120),
        description: list.description,
        icon: list.icon,
      },
      source,
    );
    const items = await this.addItems(
      copy.id,
      [...list.items]
        .sort((a, b) => a.position - b.position)
        .map((i) => ({ content: i.content, notes: i.notes })),
      source,
    );
    await Promise.all(
      items.map((it, n) => {
        const labels = [...list.items].sort((a, b) => a.position - b.position)[n]?.labels ?? [];
        return labels.length ? this.changeLabels(it.id, labels, []) : null;
      }),
    );
    return (await this.get(copy.id))!;
  }

  async reorderLists(listIds: string[]) {
    const rows = await this.rows();
    const order = [
      ...listIds.filter((id) => rows.some((r) => r.id === id)),
      ...rows.map((r) => r.id).filter((id) => !listIds.includes(id)),
    ];
    const results = await Promise.all(
      order.map((id, i) =>
        this.db
          .from("lists")
          .update({ position: (i + 1) * 1024 })
          .eq("id", id)
          .eq("workspace_id", this.workspaceId),
      ),
    );
    const failed = results.find((r) => r.error)?.error;
    if (failed && notMigrated(failed.code))
      throw new AppError("CAPABILITY_UNAVAILABLE", "This needs the latest ELISE database update", {
        recovery: "review",
      });
    check(failed ?? null, "reorder the lists");
  }

  private async lastPosition(listId: string) {
    const { data: last } = await this.db
      .from("list_items")
      .select("position")
      .eq("workspace_id", this.workspaceId)
      .eq("list_id", listId)
      .order("position", { ascending: false })
      .limit(1)
      .maybeSingle();
    return Number(last?.position ?? 0);
  }

  /** One insert for every item (no per-item round trip). */
  async addItems(
    listId: string,
    items: (string | { content: string; notes?: string | null; checked?: boolean })[],
    source: EntrySource,
  ) {
    const start = await this.lastPosition(listId);
    const now = new Date().toISOString();
    const insert = (withCheckedAt: boolean) =>
      this.db
        .from("list_items")
        .insert(
          items.map((it, i) => {
            const checked = typeof it !== "string" && it.checked === true;
            return {
              workspace_id: this.workspaceId,
              list_id: listId,
              content: typeof it === "string" ? it : it.content,
              notes: typeof it === "string" ? null : (it.notes ?? null),
              position: start + (i + 1) * 1024,
              source,
              // Every row carries the same columns: a bulk insert fills a key one row lacks
              // with null (not the default), and `checked` is NOT NULL.
              checked,
              ...(withCheckedAt ? { checked_at: checked ? now : null } : {}),
            };
          }),
        )
        .select("*");
    let { data, error } = await insert(true);
    if (error && notMigrated(error.code)) ({ data, error } = await insert(false));
    check(error, "add the items");
    // Touch the list so "recent lists" reflects activity.
    await this.db
      .from("lists")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", listId)
      .eq("workspace_id", this.workspaceId);
    return [...(data ?? [])].sort((a, b) => a.position - b.position).map((r) => toItem(r));
  }

  async updateItem(
    itemId: string,
    p: {
      content?: string;
      checked?: boolean;
      notes?: string | null;
      addLabels?: string[];
      removeLabels?: string[];
    },
  ) {
    const patch = {
      ...(p.content !== undefined ? { content: p.content } : {}),
      ...(p.checked !== undefined ? { checked: p.checked } : {}),
      ...(p.notes !== undefined ? { notes: p.notes } : {}),
    };
    const write = (withCheckedAt: boolean) =>
      this.db
        .from("list_items")
        .update({
          ...patch,
          ...(withCheckedAt && p.checked !== undefined
            ? { checked_at: p.checked ? new Date().toISOString() : null }
            : {}),
        })
        .eq("id", itemId)
        .eq("workspace_id", this.workspaceId)
        .select("*")
        .maybeSingle();
    let { data, error } = await write(true);
    if (error && notMigrated(error.code)) ({ data, error } = await write(false));
    check(error, "update the item");
    if (!data) throw new AppError("NOT_FOUND", "Item not found");
    if (p.addLabels?.length || p.removeLabels?.length)
      await this.changeLabels(itemId, p.addLabels ?? [], p.removeLabels ?? []);
    return toItem(data, (await this.itemLabels([itemId])).get(itemId) ?? []);
  }

  /** The shared label system (ADR-050): reuse a label by name, create it if new. */
  private async changeLabels(itemId: string, add: string[], remove: string[]) {
    const { data: labels, error } = await this.db
      .from("labels")
      .select("id, name")
      .eq("workspace_id", this.workspaceId);
    if (error)
      throw notMigrated(error.code)
        ? new AppError("CAPABILITY_UNAVAILABLE", "Labels need the latest ELISE database update", {
            recovery: "review",
          })
        : new AppError("PROVIDER_UNAVAILABLE", "Labels are temporarily unavailable");
    const known = [...(labels ?? [])];
    const ids: string[] = [];
    for (const name of [...new Set(add.map((a) => a.trim()).filter(Boolean))]) {
      let label = known.find((l) => norm(l.name) === norm(name));
      if (!label) {
        const created = await this.db
          .from("labels")
          .insert({ workspace_id: this.workspaceId, name })
          .select("id, name")
          .single();
        check(created.error, "create the label");
        label = created.data!;
        known.push(label);
      }
      ids.push(label.id);
    }
    if (ids.length) {
      const existing = await this.db
        .from("label_assignments")
        .select("label_id")
        .eq("workspace_id", this.workspaceId)
        .eq("list_item_id", itemId);
      const have = new Set((existing.data ?? []).map((a) => a.label_id));
      const rows = ids
        .filter((id) => !have.has(id))
        .map((label_id) => ({
          workspace_id: this.workspaceId,
          label_id,
          list_item_id: itemId,
          task_id: null,
          enrichment_id: null,
        }));
      if (rows.length)
        check((await this.db.from("label_assignments").insert(rows)).error, "label the item");
    }
    const drop = known.filter((l) => remove.some((r) => norm(r) === norm(l.name))).map((l) => l.id);
    if (drop.length)
      check(
        (
          await this.db
            .from("label_assignments")
            .delete()
            .eq("workspace_id", this.workspaceId)
            .eq("list_item_id", itemId)
            .in("label_id", drop)
        ).error,
        "unlabel the item",
      );
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

  /** List and position change in one update (the item never exists in two lists). */
  async moveItem(itemId: string, toListId: string, beforeItemId?: string | null) {
    const target = await this.get(toListId);
    if (!target) throw new AppError("NOT_FOUND", "List not found");
    const ordered = [...target.items].sort((a, b) => a.position - b.position);
    const at = beforeItemId ? ordered.findIndex((i) => i.id === beforeItemId) : -1;
    const position =
      at < 0
        ? (ordered.at(-1)?.position ?? 0) + 1024
        : at === 0
          ? ordered[0]!.position / 2
          : (ordered[at - 1]!.position + ordered[at]!.position) / 2;
    const { data, error } = await this.db
      .from("list_items")
      .update({ list_id: toListId, position })
      .eq("id", itemId)
      .eq("workspace_id", this.workspaceId)
      .is("archived_at", null)
      .select("*")
      .maybeSingle();
    check(error, "move the item");
    if (!data) throw new AppError("NOT_FOUND", "Item not found");
    return toItem(data);
  }

  async clearChecked(listId: string) {
    const { data, error } = await this.db
      .from("list_items")
      .update({ archived_at: new Date().toISOString() })
      .eq("workspace_id", this.workspaceId)
      .eq("list_id", listId)
      .eq("checked", true)
      .is("archived_at", null)
      .select("id");
    check(error, "clear the checked items");
    return data?.length ?? 0;
  }

  async reorder(listId: string, itemIds: string[]) {
    const list = await this.get(listId);
    if (!list) throw new AppError("NOT_FOUND", "List not found");
    const current = [...list.items].sort((a, b) => a.position - b.position).map((i) => i.id);
    const order = [
      ...itemIds.filter((id) => current.includes(id)),
      ...current.filter((id) => !itemIds.includes(id)),
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

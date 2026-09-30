import type {
  EntrySource,
  Habit,
  HabitEntry,
  HabitsProvider,
  NewHabit,
} from "@/core/capabilities/habits";
import { AppError } from "@/core/errors";
import type { HabitEntryRow, HabitRow } from "@/infrastructure/supabase/database.types";
import type { ServerSupabase } from "@/infrastructure/supabase/server";

import { byNameOrId, check } from "./common";

const toHabit = (r: HabitRow): Habit => ({
  id: r.id,
  name: r.name,
  description: r.description,
  frequency: r.frequency_type,
  target: Number(r.target_value),
  unit: r.unit,
  preferredDays: r.preferred_days ?? [],
  active: r.active,
  startDate: r.start_date,
  createdAt: r.created_at,
});

const toEntry = (r: HabitEntryRow): HabitEntry => ({
  id: r.id,
  habitId: r.habit_id,
  date: r.entry_date,
  value: Number(r.value),
  status: r.status,
  notes: r.notes,
  source: r.source,
});

/** ELISE Habits (Native provider). Every query is scoped to the workspace explicitly. */
export class EliseHabitsProvider implements HabitsProvider {
  constructor(
    private readonly db: ServerSupabase,
    private readonly workspaceId: string,
    private readonly userId: string,
  ) {}

  async list({ includeInactive }: { includeInactive: boolean }) {
    let q = this.db
      .from("habits")
      .select("*")
      .eq("workspace_id", this.workspaceId)
      .is("archived_at", null)
      .order("created_at");
    if (!includeInactive) q = q.eq("active", true);
    const { data, error } = await q;
    check(error, "load habits");
    return (data ?? []).map(toHabit);
  }

  async find(ref: string) {
    return byNameOrId(await this.list({ includeInactive: true }), ref, (h) => h.name);
  }

  async create(h: NewHabit, source: EntrySource) {
    const { data, error } = await this.db
      .from("habits")
      .insert({
        workspace_id: this.workspaceId,
        name: h.name,
        description: h.description ?? null,
        frequency_type: h.frequency,
        target_value: h.target,
        unit: h.unit ?? null,
        preferred_days: h.preferredDays ?? [],
        start_date: h.startDate,
        source,
        created_by_user_id: this.userId,
      })
      .select("*")
      .single();
    check(error, "create the habit");
    return toHabit(data!);
  }

  async update(id: string, p: Partial<NewHabit> & { active?: boolean }) {
    const { data, error } = await this.db
      .from("habits")
      .update({
        ...(p.name !== undefined ? { name: p.name } : {}),
        ...(p.description !== undefined ? { description: p.description } : {}),
        ...(p.frequency !== undefined ? { frequency_type: p.frequency } : {}),
        ...(p.target !== undefined ? { target_value: p.target } : {}),
        ...(p.unit !== undefined ? { unit: p.unit } : {}),
        ...(p.preferredDays !== undefined ? { preferred_days: p.preferredDays } : {}),
        ...(p.active !== undefined ? { active: p.active } : {}),
      })
      .eq("id", id)
      .eq("workspace_id", this.workspaceId)
      .is("archived_at", null)
      .select("*")
      .maybeSingle();
    check(error, "update the habit");
    if (!data) throw new AppError("NOT_FOUND", "Habit not found");
    return toHabit(data);
  }

  async archive(id: string) {
    const { data } = await this.db
      .from("habits")
      .update({ archived_at: new Date().toISOString(), active: false })
      .eq("id", id)
      .eq("workspace_id", this.workspaceId)
      .select("*")
      .maybeSingle();
    if (!data) throw new AppError("NOT_FOUND", "Habit not found");
    return toHabit(data);
  }

  async entries(habitIds: string[], from: string, to: string) {
    if (!habitIds.length) return [];
    const { data, error } = await this.db
      .from("habit_entries")
      .select("*")
      .eq("workspace_id", this.workspaceId)
      .in("habit_id", habitIds)
      .gte("entry_date", from)
      .lte("entry_date", to);
    check(error, "load check-ins");
    return (data ?? []).map(toEntry);
  }

  async checkIn(
    habitId: string,
    e: {
      date: string;
      value: number;
      mode: "add" | "set";
      status: "done" | "skipped";
      notes?: string | null;
    },
    source: EntrySource,
  ) {
    const { data: existing } = await this.db
      .from("habit_entries")
      .select("*")
      .eq("workspace_id", this.workspaceId)
      .eq("habit_id", habitId)
      .eq("entry_date", e.date)
      .maybeSingle();
    const value =
      e.status === "skipped"
        ? 0
        : e.mode === "add" && existing?.status === "done"
          ? Number(existing.value) + e.value
          : e.value;
    // One row per habit and day (unique): a second check-in updates it, never duplicates.
    const { data, error } = await this.db
      .from("habit_entries")
      .upsert(
        {
          workspace_id: this.workspaceId,
          habit_id: habitId,
          entry_date: e.date,
          value,
          status: e.status,
          notes: e.notes ?? existing?.notes ?? null,
          source,
        },
        { onConflict: "habit_id,entry_date" },
      )
      .select("*")
      .single();
    check(error, "save the check-in");
    return toEntry(data!);
  }

  async removeEntry(habitId: string, date: string) {
    await this.db
      .from("habit_entries")
      .delete()
      .eq("workspace_id", this.workspaceId)
      .eq("habit_id", habitId)
      .eq("entry_date", date);
  }
}

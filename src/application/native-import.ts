import "server-only";

import { buildPreview, type ImportKind, type ImportPreview } from "@/core/native/import";
import { todayIn } from "@/core/time";
import { logger } from "@/infrastructure/observability/logger";
import { EliseGoalsProvider } from "@/infrastructure/providers/elise-native/goals";
import { EliseHabitsProvider } from "@/infrastructure/providers/elise-native/habits";
import { EliseListsProvider } from "@/infrastructure/providers/elise-native/lists";

import type { AuthContext } from "./auth-context";

export type { ImportKind };

/** Step 1: columns detected, mapping proposed, every row validated — nothing written. */
export async function previewImport(
  kind: ImportKind,
  csv: string,
  listName?: string,
): Promise<ImportPreview> {
  return buildPreview(csv, kind, null, listName);
}

/**
 * Step 2 (after the user confirmed the mapping): create the valid rows with source "import";
 * invalid rows are skipped and reported. One failing row never stops the others.
 */
export async function commitImport(
  auth: AuthContext,
  kind: ImportKind,
  csv: string,
  mapping: Record<string, string>,
  listName?: string,
) {
  const preview = buildPreview(csv, kind, mapping, listName);
  const failed = [...preview.invalid];
  let created = 0;
  const args = [auth.db, auth.workspaceId, auth.userId] as const;

  if (kind === "habits") {
    const habits = new EliseHabitsProvider(...args);
    for (const { row, record } of preview.valid) {
      if (record.kind !== "habits") continue;
      try {
        await habits.create({ ...record, startDate: todayIn(auth.profile.timezone) }, "import");
        created++;
      } catch (error) {
        failed.push({ row, errors: [error instanceof Error ? error.message : "Could not create"] });
      }
    }
  } else if (kind === "goals") {
    const goals = new EliseGoalsProvider(...args);
    for (const { row, record } of preview.valid) {
      if (record.kind !== "goals") continue;
      try {
        const goal = await goals.create(
          {
            title: record.title,
            description: record.description,
            targetDate: record.targetDate,
            progressType: record.targetValue !== null ? "numeric" : "binary",
            progressMode: "manual",
            currentValue: record.currentValue,
            targetValue: record.targetValue,
            metric: record.metric,
          },
          "import",
        );
        if (record.status !== "active") await goals.update(goal.id, { status: record.status });
        created++;
      } catch (error) {
        failed.push({ row, errors: [error instanceof Error ? error.message : "Could not create"] });
      }
    }
  } else {
    const lists = new EliseListsProvider(...args);
    const byList = new Map<
      string,
      { row: number; item: string; checked: boolean; notes: string | null }[]
    >();
    for (const { row, record } of preview.valid) {
      if (record.kind !== "lists") continue;
      byList.set(record.list, [...(byList.get(record.list) ?? []), { row, ...record }]);
    }
    for (const [name, items] of byList) {
      try {
        // Import into an existing list of that name, or a new one.
        const existing = (await lists.find(name)).find(
          (l) => l.name.toLowerCase() === name.toLowerCase(),
        );
        const list = existing ?? (await lists.create({ name }, "import"));
        const added = await lists.addItems(
          list.id,
          items.map((i) => i.item),
          "import",
        );
        await Promise.all(
          added.map((a, i) =>
            items[i]!.checked || items[i]!.notes
              ? lists.updateItem(a.id, { checked: items[i]!.checked, notes: items[i]!.notes })
              : null,
          ),
        );
        created += added.length;
      } catch (error) {
        for (const i of items)
          failed.push({
            row: i.row,
            errors: [error instanceof Error ? error.message : "Could not create"],
          });
      }
    }
  }

  await auth.db.from("audit_events").insert({
    workspace_id: auth.workspaceId,
    user_id: auth.userId,
    event_type: "native.import",
    resource_type: kind,
    origin: "user_ui",
    result: failed.length ? "failure" : "success",
    metadata: { created, failed: failed.length, rows: preview.total },
  });
  logger.info("native.import", { kind, created, failed: failed.length, rows: preview.total });
  return { created, failed: failed.sort((a, b) => a.row - b.row) };
}

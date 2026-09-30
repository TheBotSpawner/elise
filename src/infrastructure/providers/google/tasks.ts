import {
  matchTaskLists,
  type CreateTaskInput,
  type Task,
  type TaskList,
  type TaskProvider,
  type TaskQuery,
  type UpdateTaskInput,
} from "@/core/capabilities/tasks";
import { AppError } from "@/core/errors";
import { makeExternalRef, parseExternalRef } from "@/core/providers/refs";
import { addDays } from "@/core/time";

import type { GoogleConnectionInfo } from "./calendar";
import type { GoogleHttp } from "./http";

const API = "https://tasks.googleapis.com/tasks/v1";
/** Every list of the account is read (Google allows a few dozen at most). */
const MAX_LISTS = 100;
/** Pages of 100 per list, enough for any real open-task list; completed stop at `limit`. */
const MAX_PAGES = 10;

export interface GTaskList {
  id: string;
  title?: string;
}

export interface GTask {
  id: string;
  title?: string;
  notes?: string;
  status?: "needsAction" | "completed";
  /** RFC 3339; Google Tasks only keeps the date part. */
  due?: string;
  completed?: string;
  updated?: string;
  deleted?: boolean;
  hidden?: boolean;
  webViewLink?: string;
}

// ── Normalization ────────────────────────────────────────────────────────────

export function normalizeTask(task: GTask, list: GTaskList, conn: GoogleConnectionInfo): Task {
  const updated = task.updated ?? new Date(0).toISOString();
  return {
    id: makeExternalRef(conn.connectionId, "task", list.id, task.id),
    title: task.title?.trim() || "(untitled)",
    description: null,
    notes: task.notes ?? null,
    status: task.status === "completed" ? "completed" : "pending",
    priority: null,
    category: null,
    dueDate: task.due ? task.due.slice(0, 10) : null,
    completedAt: task.status === "completed" ? (task.completed ?? updated) : null,
    // Google does not expose creation time; `updated` is the closest stable signal.
    createdAt: updated,
    updatedAt: updated,
    provenance: {
      providerKey: "google",
      connectionId: conn.connectionId,
      externalId: task.id,
      source: conn.label,
      listId: makeExternalRef(conn.connectionId, "list", list.id),
      listName: list.title ?? "Tasks",
      url: task.webViewLink,
    },
  };
}

export function toGoogleDue(date: string): string {
  return `${date}T00:00:00.000Z`;
}

function unsupported(field: string): AppError {
  return new AppError(
    "VALIDATION_ERROR",
    `Google Tasks doesn't support ${field}. Leave it out or use ELISE Tasks.`,
    {
      recovery: "review",
    },
  );
}

// ── Adapter ──────────────────────────────────────────────────────────────────

export class GoogleTasksProvider implements TaskProvider {
  private lists: Promise<GTaskList[]> | null = null;

  constructor(
    private readonly conn: GoogleConnectionInfo,
    private readonly http: GoogleHttp,
  ) {}

  private allLists(): Promise<GTaskList[]> {
    this.lists ??= (async () => {
      const lists: GTaskList[] = [];
      let pageToken: string | undefined;
      do {
        const r = await this.http.request<{ items?: GTaskList[]; nextPageToken?: string }>(
          "GET",
          `${API}/users/@me/lists?maxResults=100${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`,
        );
        lists.push(...(r?.items ?? []));
        pageToken = r?.nextPageToken;
      } while (pageToken && lists.length < MAX_LISTS);
      return lists;
    })();
    return this.lists;
  }

  private async listById(listId: string): Promise<GTaskList> {
    return (await this.allLists()).find((l) => l.id === listId) ?? { id: listId, title: "Tasks" };
  }

  private parse(ref: string, kind: "task" | "list"): string[] {
    const parsed = parseExternalRef(ref);
    if (!parsed || parsed.connectionId !== this.conn.connectionId || parsed.parts[0] !== kind) {
      throw new AppError(
        "VALIDATION_ERROR",
        `That ${kind === "task" ? "task" : "task list"} does not belong to this account`,
        {
          recovery: "review",
        },
      );
    }
    return parsed.parts.slice(1);
  }

  private taskUrl(listId: string, taskId: string): string {
    return `${API}/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(taskId)}`;
  }

  async listLists(): Promise<TaskList[]> {
    // Google's first list is the account's default ("My Tasks").
    return (await this.allLists()).map((l, i) => ({
      id: makeExternalRef(this.conn.connectionId, "list", l.id),
      name: l.title ?? "Tasks",
      isDefault: i === 0,
      provenance: {
        providerKey: "google",
        connectionId: this.conn.connectionId,
        source: this.conn.label,
      },
    }));
  }

  async list(query: TaskQuery): Promise<Task[]> {
    const lists = await this.allLists();
    const includeCompleted = query.status !== "open";
    const perList = await Promise.all(
      lists.map(async (list) => {
        const items: GTask[] = [];
        let pageToken: string | undefined;
        for (let page = 0; page < MAX_PAGES; page++) {
          const params = new URLSearchParams({
            maxResults: "100",
            showCompleted: String(includeCompleted),
            showHidden: String(includeCompleted),
          });
          if (query.dueFrom) params.set("dueMin", toGoogleDue(query.dueFrom));
          // dueMax is exclusive at Google; our dueTo is an inclusive date.
          if (query.dueTo) params.set("dueMax", toGoogleDue(addDays(query.dueTo, 1)));
          if (pageToken) params.set("pageToken", pageToken);
          const res = await this.http.request<{ items?: GTask[]; nextPageToken?: string }>(
            "GET",
            `${API}/lists/${encodeURIComponent(list.id)}/tasks?${params}`,
          );
          items.push(...(res?.items ?? []));
          pageToken = res?.nextPageToken;
          if (!pageToken || items.length >= query.limit) break;
        }
        return items.filter((t) => !t.deleted).map((t) => normalizeTask(t, list, this.conn));
      }),
    );
    const search = query.search?.toLowerCase();
    return perList
      .flat()
      .filter((t) => {
        if (query.status === "open" && t.status === "completed") return false;
        if (query.status === "completed" && t.status !== "completed") return false;
        if (query.noDueDate && t.dueDate) return false;
        if (search && !t.title.toLowerCase().includes(search)) return false;
        return true;
      })
      .sort((a, b) =>
        query.status === "completed"
          ? (b.completedAt ?? "").localeCompare(a.completedAt ?? "")
          : (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999"),
      )
      .slice(0, query.limit);
  }

  async get(taskId: string): Promise<Task | null> {
    const [listId, id] = this.parse(taskId, "task");
    const task = await this.http.request<GTask>("GET", this.taskUrl(listId!, id!), undefined, {
      notFoundAsNull: true,
    });
    if (!task || task.deleted) return null;
    return normalizeTask(task, await this.listById(listId!), this.conn);
  }

  async create(input: CreateTaskInput): Promise<Task> {
    if (input.priority) throw unsupported("priorities");
    if (input.category) throw unsupported("categories");
    const listId = input.list ? await this.resolveList(input.list) : "@default";
    const notes = [input.description, input.notes].filter(Boolean).join("\n\n") || undefined;
    const created = await this.http.request<GTask>(
      "POST",
      `${API}/lists/${encodeURIComponent(listId)}/tasks`,
      {
        title: input.title,
        notes,
        due: input.dueDate ? toGoogleDue(input.dueDate) : undefined,
      },
    );
    const list =
      listId === "@default"
        ? ((await this.allLists())[0] ?? { id: listId })
        : await this.listById(listId);
    return normalizeTask(created!, list, this.conn);
  }

  /** A list of this account by its ref or its name ("Clients"). */
  private async resolveList(ref: string): Promise<string> {
    const parsed = parseExternalRef(ref);
    if (parsed) return this.parse(ref, "list")[0]!;
    const lists = await this.allLists();
    const matches = matchTaskLists(
      lists.map((l) => ({ id: l.id, name: l.title ?? "Tasks" })),
      ref,
    );
    if (matches.length === 1) return matches[0]!.id;
    throw new AppError(
      "VALIDATION_ERROR",
      matches.length
        ? `Several lists in ${this.conn.label} match "${ref}": ${matches.map((l) => l.name).join(", ")}. Ask which one.`
        : `${this.conn.label} has no list called "${ref}". Lists: ${lists.map((l) => l.title).join(", ")}.`,
      { recovery: "review" },
    );
  }

  async update(input: UpdateTaskInput): Promise<Task> {
    if (input.list) throw unsupported("moving tasks between lists");
    if (input.priority) throw unsupported("priorities");
    if (input.category) throw unsupported("categories");
    if (input.status === "in_progress" || input.status === "cancelled")
      throw unsupported(`the "${input.status}" status`);
    const body: Record<string, unknown> = {};
    if (input.title !== undefined) body.title = input.title;
    if (input.notes !== undefined || input.description !== undefined) {
      body.notes = [input.description, input.notes].filter(Boolean).join("\n\n") || null;
    }
    if (input.dueDate !== undefined) body.due = input.dueDate ? toGoogleDue(input.dueDate) : null;
    if (input.status === "pending") Object.assign(body, { status: "needsAction", completed: null });
    return this.patch(input.taskId, body);
  }

  complete(taskId: string): Promise<Task> {
    return this.patch(taskId, { status: "completed" });
  }

  reopen(taskId: string): Promise<Task> {
    return this.patch(taskId, { status: "needsAction", completed: null });
  }

  /** Google Tasks deletes permanently; the policy engine asks before ELISE-initiated deletes. */
  async archive(taskId: string): Promise<Task> {
    const current = await this.get(taskId);
    if (!current)
      throw new AppError("NOT_FOUND", "That task no longer exists", { recovery: "review" });
    const [listId, id] = this.parse(taskId, "task");
    await this.http.request("DELETE", this.taskUrl(listId!, id!));
    return current;
  }

  private async patch(taskId: string, body: Record<string, unknown>): Promise<Task> {
    const [listId, id] = this.parse(taskId, "task");
    const updated = await this.http.request<GTask>("PATCH", this.taskUrl(listId!, id!), body);
    return normalizeTask(updated!, await this.listById(listId!), this.conn);
  }
}

import type { ToolDefinition, ToolRunEnv } from "../agents/tools";
import {
  createTaskInput,
  createTaskListInput,
  listTaskListsInput,
  listTasksInput,
  taskIdInput,
  toTaskQuery,
  updateTaskInput,
  type Task,
  type TaskList,
} from "../capabilities/tasks";
import { AppError } from "../errors";
import { parseExternalRef } from "../providers/refs";

/** Compact task view for the model: enough to reason and reference, nothing more. */
function forModel(task: Task) {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    priority: task.priority,
    dueDate: task.dueDate,
    category: task.category,
    source: task.provenance.source,
    ...(task.provenance.listName ? { list: task.provenance.listName } : {}),
    ...(task.description ? { description: task.description } : {}),
  };
}

function provider(env: ToolRunEnv) {
  return env.providers.get("tasks", env.binding);
}

async function existingTask(env: ToolRunEnv, taskId: string): Promise<Task> {
  const task = await provider(env).get(taskId);
  if (!task) throw new AppError("NOT_FOUND", "Task not found", { recovery: "review" });
  return task;
}

/** Existing tasks live where their id says: external refs name their connection, UUIDs are ELISE. */
function routeTask(input: unknown) {
  const { taskId } = taskIdInput.parse({ taskId: (input as { taskId?: unknown }).taskId });
  const external = parseExternalRef(taskId);
  return external
    ? { connectionId: external.connectionId }
    : { providerKey: "elise_native" as const };
}

const target = (id: string) => ({ type: "task", id });

const UUID = /^[0-9a-f-]{36}$/i;

/** A new task goes to the account its list belongs to (a list ref or an ELISE list id). */
function routeList(input: unknown) {
  const list = (input as { list?: unknown }).list;
  if (typeof list !== "string") return null;
  const external = parseExternalRef(list);
  if (external) return { connectionId: external.connectionId };
  return UUID.test(list) ? { providerKey: "elise_native" as const } : null;
}

function sortTasks(tasks: Task[], status?: string): Task[] {
  if (status === "completed")
    return [...tasks].sort((a, b) => (b.completedAt ?? "").localeCompare(a.completedAt ?? ""));
  return [...tasks].sort((a, b) => {
    if (a.dueDate && b.dueDate) return a.dueDate.localeCompare(b.dueDate);
    if (a.dueDate) return -1;
    if (b.dueDate) return 1;
    return b.createdAt.localeCompare(a.createdAt);
  });
}

function listsOutput(lists: TaskList[]) {
  return { lists: lists.map((l) => ({ id: l.id, name: l.name, source: l.provenance.source })) };
}

export const listTasksTool: ToolDefinition = {
  name: "tasks.list",
  capability: "tasks",
  operation: "list",
  description:
    "List the user's tasks across their connected task accounts (ELISE and others). Use to answer questions about pending/overdue/today's tasks or to find a task's id before updating, completing or deleting it (use `search` with a few words of the title).",
  input: listTasksInput,
  async describe() {
    return { summary: "List tasks" };
  },
  async run(input, env) {
    const parsed = listTasksInput.parse(input);
    const tasks = await provider(env).list(toTaskQuery(parsed, env.ctx.timezone, env.ctx.now));
    return {
      output: { count: tasks.length, tasks: tasks.map(forModel) },
      display: { kind: "task_list", tasks },
    };
  },
  merge(results, input) {
    const { limit, status } = listTasksInput.parse(input);
    const tasks = sortTasks(
      results.flatMap(({ result }) =>
        result.display?.kind === "task_list" ? result.display.tasks : [],
      ),
      status,
    ).slice(0, limit);
    return {
      output: { count: tasks.length, tasks: tasks.map(forModel) },
      display: { kind: "task_list", tasks },
    };
  },
};

export const listTaskListsTool: ToolDefinition = {
  name: "tasks.listLists",
  capability: "tasks",
  operation: "listLists",
  description:
    "List task lists in the user's task accounts. Use only when the user mentions a specific list.",
  input: listTaskListsInput,
  async describe() {
    return { summary: "List task lists" };
  },
  async run(_input, env) {
    const lists = await provider(env).listLists();
    return { output: listsOutput(lists), display: { kind: "task_lists", lists } };
  },
  merge(results) {
    const lists = results.flatMap(({ result }) =>
      result.display?.kind === "task_lists" ? result.display.lists : [],
    );
    return { output: listsOutput(lists), display: { kind: "task_lists", lists } };
  },
};

export const createTaskTool: ToolDefinition = {
  name: "tasks.create",
  capability: "tasks",
  operation: "create",
  description:
    'Create a task. `dueDate` must be an explicit YYYY-MM-DD date resolved from the current date in the user\'s timezone. Only set priority/category when the user implies them. Set `destination` only when the user says which account ("Personal", "Firbot"), and `list` when they name a list ("my Firbot Clients list" → destination "Firbot", list "Clients"). If the tool says a list is ambiguous or missing, ask.',
  input: createTaskInput,
  route: routeList,
  async describe(input, env) {
    return {
      summary: `Create task “${createTaskInput.parse(input).title}” in ${env.binding.label}`,
    };
  },
  async run(input, env) {
    const task = await provider(env).create(createTaskInput.parse(input), {
      userId: env.ctx.userId,
      source: env.ctx.origin === "user_ui" ? "user_ui" : env.ctx.origin === "ai" ? "ai" : "system",
    });
    return {
      output: { created: forModel(task) },
      display: { kind: "task", task, change: "created" },
      target: target(task.id),
    };
  },
};

export const updateTaskTool: ToolDefinition = {
  name: "tasks.update",
  capability: "tasks",
  operation: "update",
  description:
    "Edit an existing task (title, description, notes, status pending/in_progress/cancelled, priority, category, dueDate). Pass null to clear a field. Use tasks.complete to mark it done.",
  input: updateTaskInput,
  route: routeTask,
  async describe(input, env) {
    const { taskId } = updateTaskInput.parse(input);
    const task = await existingTask(env, taskId);
    return { summary: `Update task “${task.title}”`, target: target(taskId) };
  },
  async run(input, env) {
    const task = await provider(env).update(updateTaskInput.parse(input));
    return {
      output: { updated: forModel(task) },
      display: { kind: "task", task, change: "updated" },
      target: target(task.id),
    };
  },
};

export const completeTaskTool: ToolDefinition = {
  name: "tasks.complete",
  capability: "tasks",
  operation: "complete",
  description:
    "Mark a task as completed. If the user refers to a task by name, find its id with tasks.list first; if several tasks match, ask which one.",
  input: taskIdInput,
  route: routeTask,
  async describe(input, env) {
    const { taskId } = taskIdInput.parse(input);
    return {
      summary: `Complete task “${(await existingTask(env, taskId)).title}”`,
      target: target(taskId),
    };
  },
  async run(input, env) {
    const task = await provider(env).complete(taskIdInput.parse(input).taskId);
    return {
      output: { completed: forModel(task) },
      display: { kind: "task", task, change: "completed" },
      target: target(task.id),
    };
  },
};

export const reopenTaskTool: ToolDefinition = {
  name: "tasks.reopen",
  capability: "tasks",
  operation: "reopen",
  description: "Reopen a completed or cancelled task (sets it back to pending).",
  input: taskIdInput,
  route: routeTask,
  async describe(input, env) {
    const { taskId } = taskIdInput.parse(input);
    return {
      summary: `Reopen task “${(await existingTask(env, taskId)).title}”`,
      target: target(taskId),
    };
  },
  async run(input, env) {
    const task = await provider(env).reopen(taskIdInput.parse(input).taskId);
    return {
      output: { reopened: forModel(task) },
      display: { kind: "task", task, change: "reopened" },
      target: target(task.id),
    };
  },
};

export const deleteTaskTool: ToolDefinition = {
  name: "tasks.delete",
  capability: "tasks",
  operation: "delete",
  description:
    "Delete a task. This may require the user's approval; if so, tell the user it is waiting for their approval and do not claim it was deleted.",
  input: taskIdInput,
  route: routeTask,
  async describe(input, env) {
    const { taskId } = taskIdInput.parse(input);
    const task = await existingTask(env, taskId);
    return {
      summary: `Delete task “${task.title}” (${task.provenance.source})`,
      target: target(taskId),
    };
  },
  async run(input, env) {
    const task = await provider(env).archive(taskIdInput.parse(input).taskId);
    return {
      output: { deleted: { id: task.id, title: task.title } },
      display: { kind: "task", task, change: "deleted" },
      target: target(task.id),
    };
  },
};

export const createTaskListTool: ToolDefinition = {
  name: "tasks.createList",
  capability: "tasks",
  operation: "createList",
  description:
    'Create an ELISE task list ("Study", "Shopping"). Only when the user asks for a new list.',
  input: createTaskListInput,
  route: () => ({ providerKey: "elise_native" as const }),
  async describe(input) {
    return { summary: `Create task list “${createTaskListInput.parse(input).name}”` };
  },
  async run(input, env) {
    const p = provider(env);
    if (!p.createList)
      throw new AppError("CAPABILITY_UNAVAILABLE", "This account can't create lists here");
    const list = await p.createList(createTaskListInput.parse(input).name);
    return {
      output: { created: { id: list.id, name: list.name, source: list.provenance.source } },
      display: { kind: "task_lists", lists: [list] },
      target: { type: "task_list", id: list.id },
    };
  },
};

export const TASK_TOOLS = [
  listTasksTool,
  listTaskListsTool,
  createTaskListTool,
  createTaskTool,
  updateTaskTool,
  completeTaskTool,
  reopenTaskTool,
  deleteTaskTool,
];

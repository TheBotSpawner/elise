import type { ToolDefinition, ToolRunEnv } from "../agents/tools";
import {
  createTaskInput,
  listTasksInput,
  taskIdInput,
  toTaskQuery,
  updateTaskInput,
  type Task,
} from "../capabilities/tasks";
import { AppError } from "../errors";

/** Compact task view for the model: enough to reason and reference, nothing more. */
function forModel(task: Task) {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    priority: task.priority,
    dueDate: task.dueDate,
    category: task.category,
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

const target = (id: string) => ({ type: "task", id });

export const listTasksTool: ToolDefinition = {
  name: "tasks.list",
  capability: "tasks",
  operation: "list",
  description:
    "List the user's tasks. Use to answer questions about pending/overdue/today's tasks or to find a task's id before updating, completing or deleting it (use `search` with a few words of the title).",
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
};

export const createTaskTool: ToolDefinition = {
  name: "tasks.create",
  capability: "tasks",
  operation: "create",
  description:
    "Create a task. `dueDate` must be an explicit YYYY-MM-DD date resolved from the current date in the user's timezone. Only set priority/category when the user implies them.",
  input: createTaskInput,
  async describe(input) {
    return { summary: `Create task “${createTaskInput.parse(input).title}”` };
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
  async describe(input, env) {
    const { taskId } = taskIdInput.parse(input);
    return {
      summary: `Delete task “${(await existingTask(env, taskId)).title}”`,
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

export const TASK_TOOLS = [
  listTasksTool,
  createTaskTool,
  updateTaskTool,
  completeTaskTool,
  reopenTaskTool,
  deleteTaskTool,
];

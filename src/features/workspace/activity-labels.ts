import type { Dictionary } from "@/lib/i18n/dictionaries/en";

type ActivityKey = keyof Dictionary["chat"]["activity"]["done"];

const BY_PREFIX: Record<string, ActivityKey> = {
  calendar: "calendar",
  email: "email",
  history: "history",
  knowledge: "knowledge",
  tasks: "tasks",
  meeting: "meeting",
  web: "web",
  ui: "ui",
  settings: "settings",
  appearance: "settings",
  notifications: "settings",
  connections: "settings",
  schedules: "schedules",
  finance: "finance",
  structured: "structured",
  habits: "native",
  goals: "native",
  lists: "native",
  notes: "native",
};

/** Human activity label for a tool ("Searching your knowledge"), never its internal name. */
export function activityLabel(t: Dictionary, tool: string, running: boolean): string {
  const key = BY_PREFIX[tool.split(".")[0] ?? ""] ?? "other";
  return running ? t.chat.activity.running[key] : t.chat.activity.done[key];
}

/** Presentation tools arrange the workspace; they aren't sources worth listing. */
export const isPresentationTool = (tool: string) => tool.startsWith("ui.");

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
  location: "location",
  weather: "weather",
  markets: "markets",
  home: "home",
  contexts: "contexts",
  work: "contexts",
  study: "study",
  planning: "planning",
  briefs: "planning",
  shortcuts: "shortcuts",
  methods: "methods",
  music: "music",
  teamMessaging: "slack",
  voice: "settings",
  ui: "ui",
  settings: "settings",
  appearance: "settings",
  notifications: "settings",
  connections: "settings",
  schedules: "schedules",
  finance: "finance",
  structured: "structured",
  habits: "habits",
  goals: "goals",
  lists: "lists",
  notes: "notes",
};

/** Human activity label for a tool ("Searching your knowledge"), never its internal name. */
export function activityLabel(t: Dictionary, tool: string, running: boolean): string {
  const key = BY_PREFIX[tool.split(".")[0] ?? ""] ?? "other";
  return running ? t.chat.activity.running[key] : t.chat.activity.done[key];
}

/** Presentation tools arrange the workspace; they aren't sources worth listing. */
export const isPresentationTool = (tool: string) => tool.startsWith("ui.");

/**
 * ADR-104: a step that failed while the rest of the work went on (a web page that didn't load,
 * a source tried first) is ELISE's business, not the person's — it stays in the logs and the
 * answer says what couldn't be done. Failures show only when nothing else worked or runs.
 */
export function visibleSteps<T extends { outcome?: { status: string } | null }>(steps: T[]): T[] {
  const anyOk = steps.some((s) => !s.outcome || s.outcome.status !== "failed");
  return anyOk ? steps.filter((s) => s.outcome?.status !== "failed") : steps;
}

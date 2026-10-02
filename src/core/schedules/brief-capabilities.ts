import type { MorningBriefConfig } from "./schedule";

/** Capabilities a Morning Brief uses, for validation and display (no schema code: the UI imports it). */
export function briefCapabilities(
  config: MorningBriefConfig,
): ("calendar" | "email" | "tasks" | "habits" | "goals" | "finance" | "web_search")[] {
  const caps = new Set<
    "calendar" | "email" | "tasks" | "habits" | "goals" | "finance" | "web_search"
  >();
  for (const b of config.blocks)
    caps.add(b === "needs_reply" ? "email" : b === "news" ? "web_search" : b);
  return [...caps];
}

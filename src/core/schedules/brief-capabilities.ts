import type { MorningBriefConfig } from "./schedule";

type BriefCapability =
  | "calendar"
  | "email"
  | "tasks"
  | "habits"
  | "goals"
  | "finance"
  | "web_search"
  | "knowledge"
  | "weather";

/** Capabilities a Morning Brief uses, for validation and display (no schema code: the UI imports it). */
export function briefCapabilities(config: MorningBriefConfig): BriefCapability[] {
  const caps = new Set<BriefCapability>();
  for (const b of config.blocks)
    caps.add(b === "needs_reply" ? "email" : b === "news" ? "web_search" : b);
  return [...caps];
}

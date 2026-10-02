/** First-run onboarding (ADR-019): five short steps, every one skippable after the welcome. */
export const ONBOARDING_STEPS = ["welcome", "profile", "connect", "space", "ready"] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

export const SPACE_PRESETS = ["work", "university", "personal", "business", "custom"] as const;
export type SpacePreset = (typeof SPACE_PRESETS)[number];

/** How each preset Space looks (keys from core/knowledge/appearance). */
export const PRESET_APPEARANCE = {
  work: { icon: "briefcase", color: "blue" },
  university: { icon: "graduation", color: "violet" },
  personal: { icon: "home", color: "green" },
  business: { icon: "building", color: "amber" },
  custom: { icon: "folder", color: "slate" },
} as const satisfies Record<SpacePreset, { icon: string; color: string }>;

export interface OnboardingProgress {
  step: OnboardingStep;
  spacePreset?: SpacePreset | null;
  spaceId?: string | null;
}

/** What the first prompt on Home can build on. */
export interface FirstRunSetup {
  calendar: boolean;
  email: boolean;
  tasks: boolean;
  spacePreset: SpacePreset | null;
  spaceName: string | null;
}

/**
 * Suggested first prompts, best first, from what the user set up. Copy comes from the
 * dictionary; this only decides which ones fit.
 */
export function firstPromptKeys(setup: FirstRunSetup): FirstPromptKey[] {
  const keys: FirstPromptKey[] = [];
  if (setup.calendar) keys.push("today");
  if (setup.spacePreset === "university") keys.push("subjectSection");
  if (setup.spacePreset === "work" || setup.spacePreset === "business") keys.push("clientSection");
  if (setup.email) keys.push("importantEmail");
  keys.push("planDay");
  if (!setup.calendar) keys.push("firstTask");
  return [...new Set(keys)].slice(0, 3);
}

export type FirstPromptKey =
  "today" | "subjectSection" | "clientSection" | "importantEmail" | "planDay" | "firstTask";

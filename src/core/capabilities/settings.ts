import { AppError } from "../errors";
import type { MemoryChange, MemoryFact, ProfileLine, RememberInput } from "../memory/model";
import type { ElisePersonality } from "../personality";
import { isValidTimezone } from "../time";
import type { VoiceKey } from "../voice/catalog";
import type { VoiceLanguage } from "../voice/preferences";

/**
 * ELISE Self-Control (ADR-012): the product settings ELISE may change for the user, through
 * typed tools and validated values only. Nothing here reaches code, prompts, security policy,
 * permissions or secrets — only modeled preferences.
 */

export const THEMES = ["system", "dark", "light"] as const;
export type Theme = (typeof THEMES)[number];

/** Approved ELISE accents (design tokens). Cyan is the default. No free-form colors. */
export const ACCENTS = ["cyan", "blue", "violet", "green", "amber"] as const;
export type Accent = (typeof ACCENTS)[number];
export const DEFAULT_ACCENT: Accent = "cyan";

export type Notify = "none" | "in_app" | "browser";

export interface ElisePreferences {
  displayName: string | null;
  language: "es" | "en";
  timezone: string;
  theme: Theme;
  accent: Accent;
}

/**
 * Voice behavior ELISE may change (ADR-068): continuous conversation and the voice language.
 * The wake phrase is always "Elise"; barge-in and adaptive delivery are defaults, not settings.
 */
export interface VoiceSettings {
  continuous: boolean;
  language: VoiceLanguage;
}

export interface ScheduleSummary {
  id: string;
  name: string;
  status: "active" | "paused" | "needs_attention" | "completed" | "archived";
  notify: Notify;
  nextRunAt: string | null;
}

export interface ConnectionSummary {
  name: string;
  provider: string;
  account: string | null;
  status: string;
  capabilities: string[];
}

/** What ELISE may read and change about itself for this user (implemented in the app layer). */
export interface SettingsStore {
  get(): Promise<ElisePreferences>;
  update(
    patch: Partial<Pick<ElisePreferences, "language" | "timezone" | "theme" | "accent">>,
  ): Promise<ElisePreferences>;
  schedules(): Promise<ScheduleSummary[]>;
  setSchedulePaused(id: string, paused: boolean): Promise<void>;
  setScheduleNotify(id: string, notify: Notify): Promise<void>;
  connections(): Promise<ConnectionSummary[]>;
  voice(): Promise<VoiceSettings>;
  updateVoice(patch: Partial<VoiceSettings>): Promise<VoiceSettings>;
  /** The curated voice in use and the ones that can be chosen now (ADR-030), by stable key. */
  voices(): Promise<{ current: VoiceKey; available: VoiceKey[] }>;
  /** Sets the voice: the same preference Settings writes; validated and audited. */
  setVoice(key: VoiceKey): Promise<VoiceKey>;
  /** ELISE's base personality (ADR-076): the same preference Settings › Personalidad writes. */
  personality(): Promise<ElisePersonality>;
  setPersonality(p: ElisePersonality): Promise<ElisePersonality>;
  /** Mi ELISE (ADR-064): which native modules this person uses, in Mi ELISE order. */
  modules(): Promise<{ key: string; enabled: boolean }[]>;
  /** Turns modules on or off (audited); data is never touched. */
  setModules(changes: Record<string, boolean>): Promise<void>;
  /** Memory (ADR-068, ADR-107): whether it's on, learning, the active facts and the profile. */
  memory(): Promise<{
    enabled: boolean;
    learning: { on: boolean; available: boolean };
    facts: MemoryFact[];
    profile: ProfileLine[];
  }>;
  remember(input: RememberInput): Promise<MemoryChange>;
  /**
   * Forgets a fact by id or key, with its earlier values and what was derived from it; how many
   * were removed, and the interactions that had supported it (still in History).
   */
  forget(idOrKey: string): Promise<{ forgotten: number; sources: string[] }>;
  /** Evidence for a question about the person: facts, how they changed, and past episodes. */
  reflect(question: string, range: { from?: string; to?: string }): Promise<MemoryEvidence>;
  /** Stops learning from conversations (only Settings turns it on). Whether it was on. */
  stopLearning(): Promise<boolean>;
}

/** What memory.reflect returns: grouped by how ELISE knows it, never mixed (ADR-107). */
export interface MemoryEvidence {
  said: EvidenceFact[];
  inferred: EvidenceFact[];
  /** Earlier values of these facts, oldest first: how things changed. */
  changes: { key: string; value: string; until: string }[];
  profile: string[];
  episodes: { at: string; title: string | null; excerpt: string; interactionId: string }[];
  /** Episodes left out because they mention something the person asked ELISE to forget. */
  omitted: number;
}

export interface EvidenceFact {
  key: string;
  value: string;
  provenance: MemoryFact["provenance"];
  certainty: number;
  since: string;
  lastConfirmed: string;
  /** Separate interactions that support it. */
  times: number;
}

const norm = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[_\s-]+/g, " ")
    .trim();

/**
 * "Buenos Aires", "buenos_aires" or "America/Argentina/Buenos_Aires" → the canonical IANA id.
 * A city matches the last segment; a country/region matches a middle segment only when it
 * names exactly one zone. Anything else is a question, never a guess.
 */
export function resolveTimezone(
  input: string,
  zones: readonly string[] = Intl.supportedValuesOf("timeZone"),
): string {
  const raw = input.trim();
  if (raw.includes("/") && isValidTimezone(raw)) return raw;
  const wanted = norm(raw);
  const city = zones.filter((z) => norm(z.split("/").at(-1)!) === wanted);
  if (city.length === 1) return city[0]!;
  const region = zones.filter((z) =>
    z
      .split("/")
      .slice(0, -1)
      .some((part) => norm(part) === wanted),
  );
  if (region.length === 1) return region[0]!;
  const candidates = (city.length ? city : region).slice(0, 8);
  throw new AppError(
    "VALIDATION_ERROR",
    candidates.length
      ? `"${input}" could be several time zones: ${candidates.join(", ")}. Ask which city.`
      : `"${input}" isn't a time zone ELISE knows. Ask for the city (e.g. Buenos Aires, London).`,
    { recovery: "review" },
  );
}

import { AppError } from "../errors";
import type { MemoryFact, RememberInput, RememberResult } from "../memory/model";
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
  /** Memory (ADR-068): whether it's on, and the active facts. */
  memory(): Promise<{ enabled: boolean; facts: MemoryFact[] }>;
  remember(input: RememberInput): Promise<RememberResult>;
  /** Forgets a fact by id or key; how many were removed. */
  forget(idOrKey: string): Promise<number>;
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

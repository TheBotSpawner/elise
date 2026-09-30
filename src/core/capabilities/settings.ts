import { AppError } from "../errors";
import { isValidTimezone } from "../time";

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

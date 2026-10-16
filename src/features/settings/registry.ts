import {
  AudioLines,
  BarChart3,
  Brain,
  CreditCard,
  HardDrive,
  Palette,
  SlidersHorizontal,
  UserRound,
  Zap,
  type LucideIcon,
} from "lucide-react";

import type { Dictionary } from "@/lib/i18n";

/**
 * Settings registry (ADR-068): the one list of categories. The desktop sidebar, the phone list
 * and the search all read it — never three hand-written lists. Each section keeps its own UI
 * and logic in its own route.
 */
export const SETTINGS_SECTIONS = [
  { id: "general", group: "personal", icon: SlidersHorizontal },
  { id: "appearance", group: "personal", icon: Palette },
  { id: "voice", group: "personal", icon: AudioLines },
  { id: "memory", group: "personal", icon: Brain },
  { id: "storage", group: "personal", icon: HardDrive },
  { id: "shortcuts", group: "personal", icon: Zap },
  { id: "account", group: "account", icon: UserRound },
  { id: "usage", group: "account", icon: BarChart3 },
  { id: "billing", group: "account", icon: CreditCard },
] as const satisfies readonly { id: string; group: "personal" | "account"; icon: LucideIcon }[];

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]["id"];
export const SETTINGS_GROUPS = ["personal", "account"] as const;

export const sectionHref = (id: SettingsSectionId) => `/settings/${id}`;

/** The section a path belongs to ("/settings/storage/images" → storage). */
export function sectionOf(pathname: string): SettingsSectionId | null {
  const id = pathname.split("/")[2];
  return SETTINGS_SECTIONS.find((s) => s.id === id)?.id ?? null;
}

/** A searchable setting: where it lives (section + anchor) and its words. */
interface SettingsEntry {
  section: SettingsSectionId;
  anchor: string;
  label: (t: Dictionary) => string;
  hint?: (t: Dictionary) => string;
}

export const SETTINGS_ENTRIES: readonly SettingsEntry[] = [
  { section: "general", anchor: "name", label: (t) => t.settingsHub.general.name },
  {
    section: "general",
    anchor: "language",
    label: (t) => t.settingsHub.general.language,
    hint: (t) => t.settingsHub.general.languageHint,
  },
  {
    section: "general",
    anchor: "timezone",
    label: (t) => t.settingsHub.general.timezone,
    hint: (t) => t.settingsHub.general.timezoneHint,
  },
  {
    section: "general",
    anchor: "location",
    label: (t) => t.settings.location.use,
    hint: (t) => t.settings.location.useHint,
  },
  {
    section: "general",
    anchor: "my-elise",
    label: (t) => t.settingsHub.general.myElise,
    hint: (t) => t.settingsHub.general.myEliseHint,
  },
  {
    section: "appearance",
    anchor: "mode",
    label: (t) => t.settingsHub.appearance.mode,
    hint: (t) => Object.values(t.settings.themes).join(" "),
  },
  {
    section: "appearance",
    anchor: "accent",
    label: (t) => t.settingsHub.appearance.accent,
    hint: (t) => Object.values(t.settings.accents).join(" "),
  },
  {
    section: "voice",
    anchor: "continuous",
    label: (t) => t.settingsHub.voice.continuous,
    hint: (t) => `${t.settingsHub.voice.continuousHint} Elise micrófono microphone`,
  },
  {
    section: "voice",
    anchor: "voice-language",
    label: (t) => t.settingsHub.voice.language,
    hint: (t) => t.settingsHub.voice.languageHint,
  },
  {
    section: "voice",
    anchor: "voice-name",
    label: (t) => t.settingsHub.voice.voice,
    hint: (t) => t.settingsHub.voice.voiceHint,
  },
  {
    section: "voice",
    anchor: "sounds",
    label: (t) => t.settings.startup.sound,
    hint: (t) => t.settingsHub.voice.sounds,
  },
  {
    section: "voice",
    anchor: "interaction-sounds",
    label: (t) => t.settings.interaction.sound,
    hint: (t) => t.settings.interaction.soundHint,
  },
  {
    section: "memory",
    anchor: "use-memory",
    label: (t) => t.settingsHub.memory.use,
    hint: (t) => t.settingsHub.memory.useHint,
  },
  { section: "memory", anchor: "summary", label: (t) => t.settingsHub.memory.summary },
  { section: "account", anchor: "sign-out", label: (t) => t.settingsHub.account.signOut },
  { section: "account", anchor: "email", label: (t) => t.settingsHub.account.email },
];

export const normalize = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

export interface SettingsHit {
  section: SettingsSectionId;
  href: string;
  label: string;
  /** The section it belongs to, when the hit is a setting inside it. */
  sectionLabel: string | null;
}

/**
 * Local, deterministic search over titles, hints and categories: every word of the query must
 * appear. Sections first, then the settings inside them.
 */
export function searchSettings(t: Dictionary, query: string): SettingsHit[] {
  const words = normalize(query).split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const matches = (text: string) => words.every((w) => normalize(text).includes(w));
  const title = (id: SettingsSectionId) => t.settingsHub.sections[id].title;
  const sections = SETTINGS_SECTIONS.filter((s) =>
    matches(`${title(s.id)} ${t.settingsHub.sections[s.id].hint}`),
  ).map((s) => ({
    section: s.id,
    href: sectionHref(s.id),
    label: title(s.id),
    sectionLabel: null,
  }));
  const entries = SETTINGS_ENTRIES.filter((e) =>
    matches(`${e.label(t)} ${e.hint?.(t) ?? ""} ${title(e.section)}`),
  ).map((e) => ({
    section: e.section,
    href: `${sectionHref(e.section)}#${e.anchor}`,
    label: e.label(t),
    sectionLabel: title(e.section),
  }));
  return [...sections, ...entries].slice(0, 12);
}

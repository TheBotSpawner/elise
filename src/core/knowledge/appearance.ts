/**
 * The curated icons and accent colors a Knowledge Space can use. A short, useful set instead
 * of hundreds of icons; the UI maps each key to its glyph and color.
 */
export const SPACE_ICONS = [
  "folder",
  "briefcase",
  "graduation",
  "book",
  "user",
  "home",
  "building",
  "sparkles",
  "rocket",
  "code",
  "flask",
  "heart",
  "plane",
  "globe",
  "landmark",
  "wallet",
  "camera",
  "leaf",
] as const;
export type SpaceIcon = (typeof SPACE_ICONS)[number];

export const SPACE_COLORS = [
  "slate",
  "blue",
  "cyan",
  "teal",
  "green",
  "amber",
  "orange",
  "rose",
  "violet",
] as const;
export type SpaceColor = (typeof SPACE_COLORS)[number];

export const DEFAULT_SPACE_ICON: SpaceIcon = "folder";
export const DEFAULT_SPACE_COLOR: SpaceColor = "slate";

export function spaceIcon(value: string | null | undefined): SpaceIcon {
  return (SPACE_ICONS as readonly string[]).includes(value ?? "")
    ? (value as SpaceIcon)
    : DEFAULT_SPACE_ICON;
}

export function spaceColor(value: string | null | undefined): SpaceColor {
  return (SPACE_COLORS as readonly string[]).includes(value ?? "")
    ? (value as SpaceColor)
    : DEFAULT_SPACE_COLOR;
}

/** A sensible starting look for common Space names ("University" → graduation cap, blue). */
export function suggestAppearance(name: string): { icon: SpaceIcon; color: SpaceColor } | null {
  const n = name.trim().toLowerCase();
  const rules: [RegExp, SpaceIcon, SpaceColor][] = [
    [
      /\b(university|uni|universidad|study|estudio|course|curso|facultad|college)\b/,
      "graduation",
      "blue",
    ],
    [/\b(work|trabajo|office|oficina|startup|company|empresa)\b/, "briefcase", "cyan"],
    [/\b(personal|me|yo|family|familia)\b/, "user", "violet"],
    [/\b(home|casa|hogar)\b/, "home", "violet"],
    [/\b(client-a|client|clients|cliente|clientes|agency)\b/, "building", "green"],
    [/\b(trip|travel|viaje|japan|japón|japon|vacaciones)\b/, "plane", "amber"],
    [/\b(finance|finanzas|money|plata)\b/, "wallet", "teal"],
    [/\b(code|dev|software|elise|app)\b/, "code", "cyan"],
    [/\b(health|salud|gym|fitness)\b/, "heart", "rose"],
    [/\b(research|investigación|lab)\b/, "flask", "orange"],
  ];
  for (const [re, icon, color] of rules) if (re.test(n)) return { icon, color };
  return null;
}

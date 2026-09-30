"use client";

import {
  BookOpen,
  Briefcase,
  Building2,
  Camera,
  Code2,
  FlaskConical,
  Folder,
  Globe,
  GraduationCap,
  Heart,
  Home,
  Landmark,
  Leaf,
  Plane,
  Rocket,
  Sparkles,
  User,
  Wallet,
  type LucideIcon,
} from "lucide-react";

import {
  SPACE_COLORS,
  SPACE_ICONS,
  spaceColor,
  spaceIcon,
  type SpaceColor,
  type SpaceIcon,
} from "@/core/knowledge/appearance";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

export const SPACE_GLYPHS: Record<SpaceIcon, LucideIcon> = {
  folder: Folder,
  briefcase: Briefcase,
  graduation: GraduationCap,
  book: BookOpen,
  user: User,
  home: Home,
  building: Building2,
  sparkles: Sparkles,
  rocket: Rocket,
  code: Code2,
  flask: FlaskConical,
  heart: Heart,
  plane: Plane,
  globe: Globe,
  landmark: Landmark,
  wallet: Wallet,
  camera: Camera,
  leaf: Leaf,
};

/** Mid-tone accents that read in both themes; always used softly (tinted tile, icon). */
export const SPACE_HEX: Record<SpaceColor, string> = {
  slate: "#7c8b92",
  blue: "#4f86f7",
  cyan: "#1fb6c9",
  teal: "#14a896",
  green: "#3fae5c",
  amber: "#d99a1e",
  orange: "#e0743a",
  rose: "#e05a7a",
  violet: "#8b6cf0",
};

/** The Space's icon on a faintly tinted tile. */
export function SpaceGlyph({
  icon,
  color,
  size = "md",
  className,
}: {
  icon: string | null | undefined;
  color: string | null | undefined;
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  const Icon = SPACE_GLYPHS[spaceIcon(icon)];
  const hex = SPACE_HEX[spaceColor(color)];
  const box =
    size === "sm"
      ? "size-6 rounded-md"
      : size === "lg"
        ? "size-11 rounded-xl"
        : "size-9 rounded-lg";
  const glyph = size === "sm" ? "size-3.5" : size === "lg" ? "size-5" : "size-[18px]";
  return (
    <span
      aria-hidden
      className={cn("grid shrink-0 place-items-center", box, className)}
      style={{ backgroundColor: `${hex}1f`, color: hex }}
    >
      <Icon className={glyph} />
    </span>
  );
}

export function AppearancePicker({
  icon,
  color,
  onChange,
}: {
  icon: SpaceIcon;
  color: SpaceColor;
  onChange: (next: { icon: SpaceIcon; color: SpaceColor }) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-3">
      <div role="radiogroup" aria-label={t.knowledge.icon} className="grid grid-cols-9 gap-1.5">
        {SPACE_ICONS.map((key) => {
          const Icon = SPACE_GLYPHS[key];
          const selected = key === icon;
          return (
            <button
              key={key}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={t.knowledge.icons[key]}
              title={t.knowledge.icons[key]}
              onClick={() => onChange({ icon: key, color })}
              className={cn(
                "grid aspect-square place-items-center rounded-lg transition-colors",
                selected
                  ? "bg-fg/10 text-fg ring-1 ring-border-strong"
                  : "text-muted hover:bg-active hover:text-fg",
              )}
            >
              <Icon className="size-4" aria-hidden />
            </button>
          );
        })}
      </div>
      <div role="radiogroup" aria-label={t.knowledge.color} className="flex flex-wrap gap-2">
        {SPACE_COLORS.map((key) => (
          <button
            key={key}
            type="button"
            role="radio"
            aria-checked={key === color}
            aria-label={t.knowledge.colors[key]}
            title={t.knowledge.colors[key]}
            onClick={() => onChange({ icon, color: key })}
            className={cn(
              "size-7 rounded-full transition-shadow",
              key === color && "ring-2 ring-fg/60 ring-offset-2 ring-offset-bg",
            )}
            style={{ backgroundColor: SPACE_HEX[key] }}
          />
        ))}
      </div>
    </div>
  );
}

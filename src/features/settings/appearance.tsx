"use client";

import { Check } from "lucide-react";
import { useState, useTransition } from "react";

import { useI18n } from "@/lib/i18n/client";
import { ACCENTS, applyAppearance, type Accent, type Theme } from "@/lib/theme";
import { cn } from "@/lib/utils";

import { setAccent, setTheme } from "./actions";
import { SettingsCard } from "./shell";

/** Swatches of the approved accents (the tokens themselves live in globals.css). */
export const SWATCHES: Record<Accent, string> = {
  cyan: "#1fb8c8",
  blue: "#4f86e8",
  violet: "#9272e6",
  green: "#2fae6c",
  amber: "#d49a35",
};

/** Fixed colors of each mode, so a preview shows the other mode too. */
const PALETTE = {
  light: { bg: "#eef3f4", nav: "#ffffff", card: "#ffffff", line: "#d6e0e3", text: "#9fb0b6" },
  dark: { bg: "#05090b", nav: "#0f1518", card: "#0d1316", line: "#1e2a2f", text: "#33454c" },
} as const;

/** A small ELISE: nav pill, the Orb in the accent, two cards. Drawn, not a screenshot. */
function Preview({ mode, accent }: { mode: "light" | "dark"; accent: string }) {
  const p = PALETTE[mode];
  return (
    <svg viewBox="0 0 160 100" className="block h-full w-full" aria-hidden>
      <rect width="160" height="100" fill={p.bg} />
      <rect x="44" y="7" width="72" height="9" rx="4.5" fill={p.nav} stroke={p.line} />
      <circle cx="10" cy="11.5" r="2.2" fill={accent} />
      <circle cx="80" cy="44" r="15" fill="none" stroke={accent} strokeOpacity="0.85" />
      <circle cx="80" cy="44" r="9" fill={accent} fillOpacity="0.18" stroke={accent} />
      <rect x="10" y="26" width="34" height="44" rx="5" fill={p.card} stroke={p.line} />
      <rect x="15" y="33" width="20" height="3" rx="1.5" fill={accent} />
      <rect x="15" y="40" width="24" height="2.5" rx="1.25" fill={p.text} />
      <rect x="15" y="46" width="18" height="2.5" rx="1.25" fill={p.text} />
      <rect x="116" y="26" width="34" height="30" rx="5" fill={p.card} stroke={p.line} />
      <rect x="121" y="33" width="22" height="2.5" rx="1.25" fill={p.text} />
      <rect x="121" y="39" width="16" height="2.5" rx="1.25" fill={p.text} />
      <rect x="52" y="78" width="56" height="12" rx="6" fill={p.nav} stroke={p.line} />
    </svg>
  );
}

export function AppearanceSettings({ theme, accent }: { theme: Theme; accent: Accent }) {
  const { t } = useI18n();
  const a = t.settingsHub.appearance;
  const [, startTransition] = useTransition();
  const [mode, setMode] = useState(theme);
  const [color, setColor] = useState(accent);
  const swatch = SWATCHES[color];
  return (
    <div className="flex flex-col gap-6">
      <SettingsCard title={a.mode}>
        <div id="mode" className="settings-row flex scroll-mt-24 flex-col gap-3 p-4 md:p-5">
          <p className="text-[13px] text-muted">{a.modeHint}</p>
          <div role="radiogroup" aria-label={a.mode} className="grid grid-cols-3 gap-2.5 md:gap-4">
            {(["system", "light", "dark"] as const).map((option) => (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={mode === option}
                onClick={() => {
                  setMode(option);
                  // Crossfade colour tokens and apply instantly; persist in the background.
                  applyAppearance({ theme: option });
                  startTransition(() => setTheme(option));
                }}
                className="group flex flex-col gap-2 text-left focus-visible:outline-none"
              >
                <span
                  className={cn(
                    "relative aspect-[16/10] overflow-hidden rounded-xl border-2 transition-colors",
                    mode === option
                      ? "border-accent"
                      : "border-border group-hover:border-border-strong",
                    "group-focus-visible:ring-2 group-focus-visible:ring-accent",
                  )}
                >
                  {option === "system" ? (
                    <>
                      <span className="absolute inset-0">
                        <Preview mode="light" accent={swatch} />
                      </span>
                      <span className="absolute inset-0 [clip-path:polygon(100%_0,100%_100%,0_100%)]">
                        <Preview mode="dark" accent={swatch} />
                      </span>
                    </>
                  ) : (
                    <Preview mode={option} accent={swatch} />
                  )}
                </span>
                <span className="flex items-center gap-1.5 text-[13.5px]">
                  {mode === option && <Check className="size-3.5 text-accent-text" aria-hidden />}
                  {t.settings.themes[option]}
                </span>
              </button>
            ))}
          </div>
        </div>
      </SettingsCard>

      <SettingsCard title={a.accent}>
        <div id="accent" className="settings-row flex scroll-mt-24 flex-col gap-3 p-4 md:p-5">
          <p className="text-[13px] text-muted">{a.accentHint}</p>
          <div role="radiogroup" aria-label={a.accent} className="flex flex-wrap gap-2">
            {ACCENTS.map((option) => (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={color === option}
                onClick={() => {
                  setColor(option);
                  applyAppearance({ accent: option });
                  startTransition(() => setAccent(option));
                }}
                className={cn(
                  "flex h-11 items-center gap-2.5 rounded-full border pr-4 pl-2 text-[13.5px] transition-colors md:h-10",
                  color === option
                    ? "border-accent bg-accent-soft text-fg"
                    : "border-border text-muted hover:border-border-strong hover:text-fg",
                )}
              >
                <span
                  aria-hidden
                  className="grid size-6 place-items-center rounded-full"
                  style={{ background: SWATCHES[option] }}
                >
                  {color === option && <Check className="size-3.5 text-white" />}
                </span>
                {t.settings.accents[option]}
              </button>
            ))}
          </div>
        </div>
      </SettingsCard>
    </div>
  );
}

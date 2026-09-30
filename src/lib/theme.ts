import { ACCENTS, THEMES, type Accent, type Theme } from "@/core/capabilities/settings";

export { ACCENTS, THEMES, type Accent, type Theme };
export const THEME_COOKIE = "elise-theme";

export function isTheme(value: unknown): value is Theme {
  return typeof value === "string" && (THEMES as readonly string[]).includes(value);
}

/**
 * Runs before paint when the theme follows the system, so there is no flash.
 * Explicit choices are rendered server-side from the cookie.
 */
export const SYSTEM_THEME_SCRIPT = `(function(){try{var d=document.documentElement;if(d.dataset.theme==="system"){d.classList.toggle("dark",window.matchMedia("(prefers-color-scheme: dark)").matches)}}catch(e){}})();`;

export function isAccent(value: unknown): value is Accent {
  return typeof value === "string" && (ACCENTS as readonly string[]).includes(value);
}

/**
 * Applies a theme/accent to the page instantly (Settings, or ELISE changing its appearance
 * from chat). Only approved values reach the DOM; persistence happens server-side.
 */
export function applyAppearance(next: { theme?: string; accent?: string }) {
  const root = document.documentElement;
  root.classList.add("theme-transition");
  if (isTheme(next.theme)) {
    root.dataset.theme = next.theme;
    root.classList.toggle(
      "dark",
      next.theme === "dark" ||
        (next.theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches),
    );
  }
  if (isAccent(next.accent)) root.dataset.accent = next.accent;
  window.setTimeout(() => root.classList.remove("theme-transition"), 300);
}

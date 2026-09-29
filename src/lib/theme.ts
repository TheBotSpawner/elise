export const THEMES = ["system", "dark", "light"] as const;
export type Theme = (typeof THEMES)[number];
export const THEME_COOKIE = "elise-theme";

export function isTheme(value: unknown): value is Theme {
  return typeof value === "string" && (THEMES as readonly string[]).includes(value);
}

/**
 * Runs before paint when the theme follows the system, so there is no flash.
 * Explicit choices are rendered server-side from the cookie.
 */
export const SYSTEM_THEME_SCRIPT = `(function(){try{var d=document.documentElement;if(d.dataset.theme==="system"){d.classList.toggle("dark",window.matchMedia("(prefers-color-scheme: dark)").matches)}}catch(e){}})();`;

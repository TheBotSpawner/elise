import { en, type Dictionary } from "./dictionaries/en";
import { es } from "./dictionaries/es";

export const LOCALES = ["es", "en"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "es";
export const LOCALE_COOKIE = "elise-locale";

const dictionaries: Record<Locale, Dictionary> = { es, en };

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

export function getDictionary(locale: Locale): Dictionary {
  return dictionaries[locale];
}

export type { Dictionary };

/**
 * User-facing text for an error returned by a server action. Server messages are English and
 * already free of internals (toPublicError hides INTERNAL_ERROR); other locales get the
 * localized text for the code instead of mixing languages.
 */
export function errorText(t: Dictionary, error: { code: string; message?: string }): string {
  const codes = t.errors.codes as Record<string, string>;
  if (t.errors.useServerMessages && error.message && error.code !== "INTERNAL_ERROR") {
    return error.message;
  }
  return codes[error.code] ?? codes.INTERNAL_ERROR;
}

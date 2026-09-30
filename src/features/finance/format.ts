"use client";

import type { Period } from "@/core/capabilities/finance";
import { formatMoney, parseAmount, toUnits } from "@/core/finance/money";
import { useI18n } from "@/lib/i18n/client";

export const intlLocale = (locale: "es" | "en") => (locale === "es" ? "es-AR" : "en-US");

/** Exact amounts in the user's locale ("ARS 48.000", "USD 25.50"); never via floats. */
export function useMoney() {
  const { locale } = useI18n();
  return (amount: string, currency: string) => formatMoney(amount, currency, intlLocale(locale));
}

/** "1–30 sept 2026", "29 sept 2026". */
export function usePeriodLabel() {
  const { locale } = useI18n();
  const day = new Intl.DateTimeFormat(intlLocale(locale), {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
  return (p: Period) => {
    const from = new Date(`${p.from}T00:00:00Z`);
    const to = new Date(`${p.to}T00:00:00Z`);
    return p.from === p.to ? day.format(from) : day.formatRange(from, to);
  };
}

export function useDay() {
  const { locale } = useI18n();
  const f = new Intl.DateTimeFormat(intlLocale(locale), {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
  return (iso: string) => f.format(new Date(`${iso}T00:00:00Z`));
}

export function useMonth() {
  const { locale } = useI18n();
  const f = new Intl.DateTimeFormat(intlLocale(locale), { month: "short", timeZone: "UTC" });
  return (ym: string) => f.format(new Date(`${ym}-01T00:00:00Z`));
}

/** What the user typed ("48.000", "25,50" in Spanish; "25.50" in English) → exact decimal. */
export function parseTypedAmount(value: string, locale: "es" | "en"): string | null {
  const parsed = parseAmount(value, locale === "es" ? "comma_decimal" : "dot_decimal");
  return parsed && !parsed.negative && parsed.amount !== "0" ? parsed.amount : null;
}

/** a as a percentage of b (0–100) for bar widths, computed on exact amounts. */
export function share(a: string, b: string): number {
  const whole = toUnits(b);
  return whole <= 0n ? 0 : Math.min(100, Number((toUnits(a) * 100n) / whole));
}

export const COMMON_CURRENCIES = ["ARS", "USD", "EUR", "NZD", "BRL", "GBP", "UYU", "CLP", "MXN"];

"use client";

import { createContext, useContext, type ReactNode } from "react";

import { DEFAULT_DATE_ORDER, type DateOrder } from "@/core/dates";

import { getDictionary, type Dictionary, type Locale } from ".";

const I18nContext = createContext<{ locale: Locale; t: Dictionary; dateOrder: DateOrder } | null>(
  null,
);

export function I18nProvider({
  locale,
  dateOrder = DEFAULT_DATE_ORDER,
  children,
}: {
  locale: Locale;
  /** Short dates: day first by default (ADR-078). */
  dateOrder?: DateOrder;
  children: ReactNode;
}) {
  return (
    <I18nContext.Provider value={{ locale, t: getDictionary(locale), dateOrder }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n() {
  const value = useContext(I18nContext);
  if (!value) throw new Error("useI18n must be used inside I18nProvider");
  return value;
}

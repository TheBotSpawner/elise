import "server-only";

import { cookies, headers } from "next/headers";

import { getAuthContext } from "@/application/auth-context";

import { DEFAULT_LOCALE, getDictionary, isLocale, LOCALE_COOKIE, type Locale } from ".";

/** Profile language when signed in, then cookie, then Accept-Language, then Spanish. */
export async function getLocale(): Promise<Locale> {
  const auth = await getAuthContext();
  if (auth) return auth.profile.locale;
  const cookie = (await cookies()).get(LOCALE_COOKIE)?.value;
  if (isLocale(cookie)) return cookie;
  const accept = (await headers()).get("accept-language") ?? "";
  if (/^en\b/i.test(accept)) return "en";
  return DEFAULT_LOCALE;
}

export async function getT() {
  const locale = await getLocale();
  return { locale, t: getDictionary(locale) };
}

import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { cookies } from "next/headers";
import { Toaster } from "sonner";

import { getAuthContext } from "@/application/auth-context";
import { I18nProvider } from "@/lib/i18n/client";
import { getLocale } from "@/lib/i18n/server";
import { isTheme, SYSTEM_THEME_SCRIPT, THEME_COOKIE } from "@/lib/theme";
import { cn } from "@/lib/utils";

import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: { default: "ELISE", template: "%s · ELISE" },
  description: "One intelligence. Everything under control.",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#04070c" },
    { media: "(prefers-color-scheme: light)", color: "#f5f7fb" },
  ],
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const [locale, cookieStore, auth] = await Promise.all([
    getLocale(),
    cookies(),
    getAuthContext().catch(() => null),
  ]);
  // Signed in: the profile is the source of truth (ELISE can change it from chat).
  // Signed out: the cookie keeps the last choice on this device.
  const stored = cookieStore.get(THEME_COOKIE)?.value;
  const theme = auth?.profile.theme ?? (isTheme(stored) ? stored : "system");
  const accent = auth?.profile.accent ?? "cyan";

  return (
    <html
      lang={locale}
      data-theme={theme}
      data-accent={accent}
      className={cn(geistSans.variable, geistMono.variable, "h-full", theme === "dark" && "dark")}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: SYSTEM_THEME_SCRIPT }} />
      </head>
      <body className="min-h-full">
        <I18nProvider locale={locale}>{children}</I18nProvider>
        <Toaster position="top-center" theme="system" richColors closeButton />
      </body>
    </html>
  );
}

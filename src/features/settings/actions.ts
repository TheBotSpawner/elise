"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { z } from "zod";

import { requireAuthContext } from "@/application/auth-context";
import { updatePreferences } from "@/application/settings-service";
import { toPublicError, type PublicError } from "@/core/errors";
import { isValidTimezone } from "@/core/time";
import { LOCALE_COOKIE, LOCALES } from "@/lib/i18n";
import { ACCENTS, THEME_COOKIE, THEMES } from "@/lib/theme";

const ONE_YEAR = 60 * 60 * 24 * 365;

const profileSchema = z.object({
  displayName: z.string().trim().min(1).max(120),
  language: z.enum(LOCALES),
  timezone: z.string().refine(isValidTimezone),
});

export async function updateProfile(
  input: z.input<typeof profileSchema>,
): Promise<{ ok: true } | { ok: false; error: PublicError }> {
  try {
    const data = profileSchema.parse(input);
    const auth = await requireAuthContext();
    const { error } = await auth.db
      .from("user_profiles")
      .update({ display_name: data.displayName })
      .eq("id", auth.userId);
    if (error) throw error;
    // Language and time zone go through the audited preferences path.
    await updatePreferences(auth, { language: data.language, timezone: data.timezone });
    (await cookies()).set(LOCALE_COOKIE, data.language, {
      path: "/",
      maxAge: ONE_YEAR,
      sameSite: "lax",
    });
    revalidatePath("/", "layout");
    return { ok: true };
  } catch (error) {
    return { ok: false, error: toPublicError(error) };
  }
}

export async function setTheme(theme: string): Promise<void> {
  const parsed = z.enum(THEMES).parse(theme);
  await updatePreferences(await requireAuthContext(), { theme: parsed });
  (await cookies()).set(THEME_COOKIE, parsed, { path: "/", maxAge: ONE_YEAR, sameSite: "lax" });
  revalidatePath("/", "layout");
}

export async function setAccent(accent: string): Promise<void> {
  await updatePreferences(await requireAuthContext(), { accent: z.enum(ACCENTS).parse(accent) });
  revalidatePath("/", "layout");
}

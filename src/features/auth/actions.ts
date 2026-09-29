"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";

import { isValidTimezone } from "@/core/time";
import { logger } from "@/infrastructure/observability/logger";
import { createClient } from "@/infrastructure/supabase/server";
import { isLocale } from "@/lib/i18n";
import { safeNextPath } from "@/lib/safe-redirect";

export type AuthFormState = {
  error?: "invalidCredentials" | "genericError";
  notice?: "magicLinkSent" | "confirmEmail";
} | null;

const credentials = z.object({
  email: z.email().max(320),
  password: z.string().min(8).max(200),
});

async function appOrigin(): Promise<string> {
  if (process.env.NEXT_PUBLIC_APP_URL) return process.env.NEXT_PUBLIC_APP_URL.replace(/\/$/, "");
  const h = await headers();
  return h.get("origin") ?? `https://${h.get("host")}`;
}

function callbackUrl(origin: string, next: string) {
  return `${origin}/auth/callback?next=${encodeURIComponent(safeNextPath(next))}`;
}

export async function signInWithPassword(_: AuthFormState, form: FormData): Promise<AuthFormState> {
  const parsed = credentials.safeParse({
    email: form.get("email"),
    password: form.get("password"),
  });
  if (!parsed.success) return { error: "invalidCredentials" };
  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);
  if (error) {
    logger.info("auth.sign_in_failed", { code: error.code });
    return { error: error.code === "invalid_credentials" ? "invalidCredentials" : "genericError" };
  }
  redirect(safeNextPath(String(form.get("next") ?? "/")));
}

export async function signUpWithPassword(_: AuthFormState, form: FormData): Promise<AuthFormState> {
  const parsed = credentials.extend({ name: z.string().trim().max(120).optional() }).safeParse({
    email: form.get("email"),
    password: form.get("password"),
    name: form.get("name") || undefined,
  });
  if (!parsed.success) return { error: "genericError" };

  const timezone = String(form.get("timezone") ?? "");
  const language = form.get("language");
  const supabase = await createClient();
  const { data, error } = await supabase.auth.signUp({
    email: parsed.data.email,
    password: parsed.data.password,
    options: {
      emailRedirectTo: callbackUrl(await appOrigin(), "/onboarding"),
      // Read by public.handle_new_user() to set up the profile and personal workspace.
      data: {
        full_name: parsed.data.name,
        timezone: isValidTimezone(timezone) ? timezone : "UTC",
        preferred_language: isLocale(language) ? language : "es",
      },
    },
  });
  if (error) {
    logger.info("auth.sign_up_failed", { code: error.code });
    return { error: "genericError" };
  }
  if (!data.session) return { notice: "confirmEmail" };
  redirect("/onboarding");
}

export async function sendMagicLink(_: AuthFormState, form: FormData): Promise<AuthFormState> {
  const email = z.email().max(320).safeParse(form.get("email"));
  if (!email.success) return { error: "genericError" };
  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithOtp({
    email: email.data,
    options: { emailRedirectTo: callbackUrl(await appOrigin(), String(form.get("next") ?? "/")) },
  });
  if (error) {
    logger.info("auth.magic_link_failed", { code: error.code });
    return { error: "genericError" };
  }
  return { notice: "magicLinkSent" };
}

export async function signInWithGoogle(form: FormData): Promise<void> {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: callbackUrl(await appOrigin(), String(form.get("next") ?? "/")) },
  });
  if (error || !data.url) {
    logger.warn("auth.google_unavailable", { code: error?.code });
    redirect("/login?error=google");
  }
  redirect(data.url);
}

export async function signOut(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}

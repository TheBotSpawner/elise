"use client";

import { Mail } from "lucide-react";
import { useActionState, useState } from "react";

import { GoogleMark } from "@/components/elise/brand-icons";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

import {
  sendMagicLink,
  signInWithGoogle,
  signInWithPassword,
  signUpWithPassword,
  type AuthFormState,
} from "./actions";

export function LoginForm({ next, initialError }: { next: string; initialError?: string }) {
  const { t, locale } = useI18n();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [passwordState, passwordAction, passwordPending] = useActionState<AuthFormState, FormData>(
    mode === "signin" ? signInWithPassword : signUpWithPassword,
    null,
  );
  const [linkState, linkAction, linkPending] = useActionState<AuthFormState, FormData>(
    sendMagicLink,
    null,
  );

  const error =
    passwordState?.error ?? linkState?.error ?? (initialError ? "genericError" : undefined);
  const notice = passwordState?.notice ?? linkState?.notice;

  return (
    <div className="w-full max-w-sm space-y-6">
      <div
        role="tablist"
        className="grid grid-cols-2 rounded-xl border border-border bg-surface p-1 text-sm"
      >
        {(["signin", "signup"] as const).map((m) => (
          <button
            key={m}
            role="tab"
            type="button"
            aria-selected={mode === m}
            onClick={() => setMode(m)}
            className={cn(
              "h-9 rounded-lg transition-colors",
              mode === m ? "bg-surface-2 font-medium text-fg" : "text-muted hover:text-fg",
            )}
          >
            {m === "signin" ? t.auth.signInTab : t.auth.signUpTab}
          </button>
        ))}
      </div>

      <form action={signInWithGoogle}>
        <input type="hidden" name="next" value={next} />
        <Button type="submit" variant="secondary" className="w-full">
          <GoogleMark />
          {t.auth.google}
        </Button>
      </form>

      <div className="flex items-center gap-3 text-xs text-muted">
        <span className="h-px flex-1 bg-border" />
        {t.auth.or}
        <span className="h-px flex-1 bg-border" />
      </div>

      <form
        action={passwordAction}
        className="space-y-3"
        onSubmit={(e) => {
          // The browser knows the user timezone; it seeds the profile on sign-up.
          const field = e.currentTarget.elements.namedItem("timezone") as HTMLInputElement;
          field.value = Intl.DateTimeFormat().resolvedOptions().timeZone;
        }}
      >
        <input type="hidden" name="next" value={next} />
        <input type="hidden" name="timezone" defaultValue="UTC" />
        <input type="hidden" name="language" value={locale} />
        {mode === "signup" && (
          <div className="space-y-1.5">
            <Label htmlFor="name">{t.auth.name}</Label>
            <Input id="name" name="name" autoComplete="name" maxLength={120} />
          </div>
        )}
        <div className="space-y-1.5">
          <Label htmlFor="email">{t.auth.email}</Label>
          <Input id="email" name="email" type="email" autoComplete="email" required />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="password">{t.auth.password}</Label>
          <Input
            id="password"
            name="password"
            type="password"
            minLength={8}
            required
            autoComplete={mode === "signin" ? "current-password" : "new-password"}
            aria-describedby="password-hint"
          />
          {mode === "signup" && (
            <p id="password-hint" className="text-xs text-muted">
              {t.auth.passwordHint}
            </p>
          )}
        </div>
        <Button type="submit" className="w-full" disabled={passwordPending}>
          {mode === "signin" ? t.auth.signIn : t.auth.signUp}
        </Button>
      </form>

      {mode === "signin" && (
        <form action={linkAction} className="flex gap-2">
          <input type="hidden" name="next" value={next} />
          <Input
            name="email"
            type="email"
            required
            placeholder={t.auth.email}
            aria-label={t.auth.email}
          />
          <Button
            type="submit"
            variant="secondary"
            size="icon"
            disabled={linkPending}
            title={t.auth.magicLink}
          >
            <Mail />
            <span className="sr-only">{t.auth.magicLink}</span>
          </Button>
        </form>
      )}

      <div aria-live="polite" className="min-h-5 text-center text-sm">
        {error && <p className="text-danger">{t.auth[error]}</p>}
        {notice && <p className="text-success">{t.auth[notice]}</p>}
      </div>
    </div>
  );
}

import type { Metadata } from "next";

import { Orb } from "@/components/elise/orb/orb";
import { isSupabaseConfigured } from "@/config/env";
import { LoginForm } from "@/features/auth/login-form";
import { getT } from "@/lib/i18n/server";
import { safeNextPath } from "@/lib/safe-redirect";

export const metadata: Metadata = { title: "Login" };

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const { t } = await getT();
  const params = await searchParams;
  const next = safeNextPath(typeof params.next === "string" ? params.next : undefined);
  const error = typeof params.error === "string" ? params.error : undefined;

  return (
    <main className="elise-halo flex min-h-dvh flex-col items-center justify-center gap-8 px-4 py-12">
      <div className="flex flex-col items-center gap-4 text-center">
        <Orb size={200} />
        <div>
          <p className="flex items-center justify-center gap-3">
            <span
              aria-hidden
              className="size-2 rounded-full bg-accent shadow-[0_0_14px_var(--accent)]"
            />
            <span className="text-[13px] font-medium tracking-[0.34em]">ELISE</span>
          </p>
          <h1 className="mt-4 text-[30px] leading-[1.15] font-light tracking-[-0.025em]">
            {t.auth.signInTitle}
          </h1>
          <p className="mt-1 text-sm text-muted">{t.meta.tagline}</p>
        </div>
      </div>

      {isSupabaseConfigured() ? (
        <LoginForm next={next} initialError={error} />
      ) : (
        <div
          role="status"
          className="max-w-md rounded-2xl border border-warning/40 bg-surface p-5 text-sm"
        >
          <p className="font-medium text-warning">{t.auth.notConfiguredTitle}</p>
          <p className="mt-2 text-muted">{t.auth.notConfiguredBody}</p>
        </div>
      )}
    </main>
  );
}

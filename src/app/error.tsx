"use client";

import Link from "next/link";
import { useEffect } from "react";

import { Orb } from "@/components/elise/orb/orb";
import { Button, buttonVariants } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n/client";

/** Route error boundary: actionable, human, with a reference instead of a stack trace. */
export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const { t } = useI18n();
  useEffect(() => {
    console.error("route.error", { digest: error.digest });
  }, [error.digest]);

  return (
    <main className="flex min-h-[70dvh] flex-col items-center justify-center gap-4 px-4 text-center">
      <Orb state="error" size={96} />
      <h1 className="text-xl font-semibold">{t.errors.title}</h1>
      <p className="max-w-sm text-sm text-muted">{t.errors.body}</p>
      {error.digest && (
        <p className="font-mono text-xs text-muted">{`${t.chat.reference}: ${error.digest}`}</p>
      )}
      <div className="flex gap-2">
        <Button onClick={reset}>{t.errors.retry}</Button>
        <Link href="/" className={buttonVariants({ variant: "secondary" })}>
          {t.errors.goHome}
        </Link>
      </div>
    </main>
  );
}

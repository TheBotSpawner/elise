import Link from "next/link";

import { buttonVariants } from "@/components/ui/button";
import { getT } from "@/lib/i18n/server";

export default async function NotFound() {
  const { t } = await getT();
  return (
    <main className="flex min-h-[70dvh] flex-col items-center justify-center gap-3 px-4 text-center">
      <p className="font-mono text-xs tracking-[0.3em] text-accent">404</p>
      <h1 className="text-xl font-semibold">{t.errors.notFoundTitle}</h1>
      <p className="max-w-sm text-sm text-muted">{t.errors.notFoundBody}</p>
      <Link href="/" className={buttonVariants({ variant: "secondary" })}>
        {t.errors.goHome}
      </Link>
    </main>
  );
}

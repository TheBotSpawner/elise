import Link from "next/link";
import type { ReactNode } from "react";

import { requireAuthContext } from "@/application/auth-context";
import { isModuleEnabled } from "@/application/modules-service";
import { MY_ELISE_ICONS } from "@/components/elise/navigation/nav-items";
import { PageContainer } from "@/components/shared/page";
import { buttonVariants } from "@/components/ui/button";
import type { NativeModuleKey } from "@/core/modules/registry";
import { getT } from "@/lib/i18n/server";

import { EnableModuleButton } from "./enable-module-button";

/**
 * The one guard for every Mi ELISE module's pages (ADR-064). A module that's off shows a calm
 * page to turn it back on — never a 404 — and its data is untouched. Bookmarks keep working.
 */
export async function NativeModuleGuard({
  module,
  children,
}: {
  module: NativeModuleKey;
  children: ReactNode;
}) {
  const [auth, { t }] = await Promise.all([requireAuthContext(), getT()]);
  if (await isModuleEnabled(auth, module)) return children;
  const name = t.capabilities[module];
  const Icon = MY_ELISE_ICONS[module];
  const m = t.myEliseModules;
  return (
    <PageContainer>
      <section
        aria-labelledby="module-off"
        className="mx-auto mt-10 flex max-w-md flex-col items-center gap-4 text-center"
      >
        <span className="grid size-14 place-items-center rounded-2xl border border-border bg-surface text-muted">
          <Icon className="size-6" strokeWidth={1.6} aria-hidden />
        </span>
        <h1 id="module-off" className="text-[22px] font-light tracking-[-0.02em]">
          {m.guardTitle(name)}
        </h1>
        <p className="text-[14px] text-muted">{m.guardBody}</p>
        <div className="mt-2 flex flex-wrap justify-center gap-2">
          <EnableModuleButton module={module} label={m.guardEnable(name)} />
          <Link href="/" className={buttonVariants({ variant: "ghost" })}>
            {m.back}
          </Link>
        </div>
      </section>
    </PageContainer>
  );
}

import Link from "next/link";

import { requireAuthContext } from "@/application/auth-context";
import { visibleModules } from "@/application/modules-service";
import { MY_ELISE_ICONS } from "@/components/elise/navigation/nav-items";
import { PageContainer, PageHeader } from "@/components/shared/page";
import { getCapability } from "@/core/capabilities/registry";
import { getT } from "@/lib/i18n/server";
import { cn } from "@/lib/utils";

/** ELISE Native modules, grouped so the primary navigation stays small. */
export default async function MyElisePage() {
  const [{ t }, modules] = await Promise.all([getT(), requireAuthContext().then(visibleModules)]);
  // The person's Mi ELISE modules (ADR-064), then the tools that aren't modules.
  const MODULES = [...modules, "methods" as const, "time" as const].map((key) => ({
    key,
    icon: MY_ELISE_ICONS[key],
    href: `/my-elise/${key}`,
  }));
  return (
    <PageContainer>
      <PageHeader title={t.myElise.title} info={[t.myElise.subtitle]} />
      {modules.length === 0 && (
        <p className="mb-4 text-sm text-muted">
          {t.myEliseModules.none}{" "}
          <Link
            href="/connections#mi-elise"
            className="text-accent-text underline-offset-2 hover:underline"
          >
            {t.myEliseModules.choose}
          </Link>
        </p>
      )}
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {MODULES.map(({ key, icon: Icon, href }) => {
          const available = getCapability(key).status === "available";
          const body = (
            <>
              <Icon
                className={cn("size-5", available ? "text-accent" : "text-muted")}
                aria-hidden
              />
              <span className="mt-6 block font-medium">{t.capabilities[key]}</span>
              <span className={cn("text-xs", available ? "text-success" : "text-muted")}>
                {available ? t.myElise.available : t.myElise.soon}
              </span>
            </>
          );
          return (
            <li key={key}>
              {available ? (
                <Link
                  href={href}
                  className="block rounded-2xl border border-border bg-surface p-4 transition-colors hover:border-accent/50"
                >
                  {body}
                </Link>
              ) : (
                <div
                  aria-disabled
                  className="rounded-2xl border border-dashed border-border p-4 opacity-70"
                >
                  {body}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </PageContainer>
  );
}

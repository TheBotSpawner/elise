import {
  BookOpenCheck,
  CheckSquare,
  Target,
  ListChecks,
  Repeat,
  StickyNote,
  Timer,
  Wallet,
  Zap,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";

import { PageContainer, PageHeader } from "@/components/shared/page";
import { getCapability } from "@/core/capabilities/registry";
import type { CapabilityKey } from "@/core/capabilities/types";
import { getT } from "@/lib/i18n/server";
import { cn } from "@/lib/utils";

const MODULES: { key: CapabilityKey; icon: LucideIcon; href: string }[] = [
  { key: "tasks", icon: CheckSquare, href: "/my-elise/tasks" },
  { key: "habits", icon: Repeat, href: "/my-elise/habits" },
  { key: "lists", icon: ListChecks, href: "/my-elise/lists" },
  { key: "goals", icon: Target, href: "/my-elise/goals" },
  { key: "notes", icon: StickyNote, href: "/my-elise/notes" },
  { key: "finance", icon: Wallet, href: "/my-elise/finance" },
  { key: "shortcuts", icon: Zap, href: "/my-elise/shortcuts" },
  { key: "methods", icon: BookOpenCheck, href: "/my-elise/methods" },
  { key: "time", icon: Timer, href: "/my-elise/time" },
];

/** ELISE Native modules, grouped so the primary navigation stays small. */
export default async function MyElisePage() {
  const { t } = await getT();
  return (
    <PageContainer>
      <PageHeader title={t.myElise.title} subtitle={t.myElise.subtitle} />
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

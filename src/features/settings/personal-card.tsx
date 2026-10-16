import { ChevronRight } from "lucide-react";
import Link from "next/link";

import { MY_ELISE_ICONS } from "@/components/elise/navigation/nav-items";
import { Card } from "@/components/ui/card";
import type { Dictionary } from "@/lib/i18n";

/**
 * Settings → your ELISE (ADR-064): Atajos live here now, and Mi ELISE's modules are chosen in
 * Connections (one place for that choice; this only points to it).
 */
export function PersonalCard({ t }: { t: Dictionary }) {
  const rows = [
    {
      href: "/settings/shortcuts",
      Icon: MY_ELISE_ICONS.shortcuts,
      title: t.shortcuts.title,
      body: t.shortcuts.subtitle,
    },
    {
      href: "/connections#mi-elise",
      Icon: MY_ELISE_ICONS.tasks,
      title: t.myEliseModules.manage,
      body: t.myEliseModules.subtitle,
    },
  ];
  return (
    <Card className="p-2">
      <ul className="flex flex-col">
        {rows.map(({ href, Icon, title, body }) => (
          <li key={href}>
            <Link
              href={href}
              className="flex items-center gap-3 rounded-xl px-3 py-3 transition-colors hover:bg-active focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
            >
              <Icon className="size-[18px] shrink-0 text-muted" strokeWidth={1.7} aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">{title}</span>
                <span className="line-clamp-1 block text-[13px] text-muted md:line-clamp-2">
                  {body}
                </span>
              </span>
              <ChevronRight className="size-4 shrink-0 text-faint" aria-hidden />
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}

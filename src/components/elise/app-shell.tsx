"use client";

import {
  BookOpen,
  CalendarClock,
  CheckSquare,
  Home,
  LogOut,
  MessagesSquare,
  Plug,
  Settings,
  ShieldCheck,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import { signOut } from "@/features/auth/actions";
import { useRealtimeRefresh } from "@/hooks/use-realtime-refresh";
import type { Dictionary } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

interface NavItem {
  href: string;
  label: keyof Dictionary["nav"];
  icon: LucideIcon;
}

/** Primary navigation stays small (docs/product/04 §6). Native modules live under My Elise. */
const PRIMARY: NavItem[] = [
  { href: "/", label: "home", icon: Home },
  { href: "/chat", label: "chat", icon: MessagesSquare },
  { href: "/knowledge", label: "knowledge", icon: BookOpen },
  { href: "/connections", label: "connections", icon: Plug },
  { href: "/schedules", label: "schedules", icon: CalendarClock },
  { href: "/my-elise", label: "myElise", icon: Sparkles },
  { href: "/settings", label: "settings", icon: Settings },
];

/** Mobile prioritizes immediacy: chat, tasks, approvals (docs/product/04 §27). */
const MOBILE: NavItem[] = [
  { href: "/", label: "home", icon: Home },
  { href: "/chat", label: "chat", icon: MessagesSquare },
  { href: "/my-elise/tasks", label: "tasks", icon: CheckSquare },
  { href: "/approvals", label: "approvals", icon: ShieldCheck },
  { href: "/settings", label: "settings", icon: Settings },
];

function isActive(pathname: string, href: string) {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}

export function AppShell({
  workspaceId,
  pendingApprovals,
  children,
}: {
  workspaceId: string;
  pendingApprovals: number;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const pathname = usePathname();
  useRealtimeRefresh(workspaceId, ["approvals", "notifications"]);

  return (
    <div className="flex min-h-dvh">
      <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col border-r border-border bg-surface/60 px-3 py-5 backdrop-blur md:flex">
        <Link href="/" className="mb-8 flex items-center gap-2 px-3">
          <span
            className="size-2.5 rounded-full bg-accent shadow-[0_0_12px_var(--glow)]"
            aria-hidden
          />
          <span className="font-mono text-sm tracking-[0.35em]">ELISE</span>
        </Link>
        <nav aria-label={t.nav.mainNavigation} className="flex flex-1 flex-col gap-1">
          {PRIMARY.map((item) => (
            <NavLink
              key={item.href}
              item={item}
              active={isActive(pathname, item.href)}
              label={t.nav[item.label]}
            />
          ))}
          <div className="my-3 h-px bg-border" />
          <NavLink
            item={{ href: "/approvals", label: "approvals", icon: ShieldCheck }}
            active={isActive(pathname, "/approvals")}
            label={t.nav.approvals}
            badge={pendingApprovals}
          />
        </nav>
        <form action={signOut}>
          <button
            type="submit"
            className="flex h-10 w-full items-center gap-3 rounded-xl px-3 text-sm text-muted transition-colors hover:bg-surface-2 hover:text-fg"
          >
            <LogOut className="size-4" aria-hidden />
            {t.nav.signOut}
          </button>
        </form>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col pb-16 md:pb-0">{children}</div>

      <nav
        aria-label={t.nav.mainNavigation}
        className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-5 border-t border-border bg-surface/90 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden"
      >
        {MOBILE.map((item) => {
          const active = isActive(pathname, item.href);
          const badge = item.label === "approvals" ? pendingApprovals : 0;
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "relative flex h-14 flex-col items-center justify-center gap-1 text-[11px]",
                active ? "text-accent" : "text-muted",
              )}
            >
              <item.icon className="size-5" aria-hidden />
              {t.nav[item.label]}
              {badge > 0 && (
                <span className="absolute top-1.5 right-[calc(50%-18px)] grid min-w-4 place-items-center rounded-full bg-warning px-1 text-[10px] font-semibold text-black">
                  {badge}
                </span>
              )}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}

function NavLink({
  item,
  active,
  label,
  badge = 0,
}: {
  item: NavItem;
  active: boolean;
  label: string;
  badge?: number;
}) {
  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "relative flex h-10 items-center gap-3 rounded-xl px-3 text-sm transition-colors",
        active ? "bg-accent-soft text-fg" : "text-muted hover:bg-surface-2 hover:text-fg",
      )}
    >
      {active && (
        <span className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-accent" aria-hidden />
      )}
      <item.icon className={cn("size-4", active && "text-accent")} aria-hidden />
      {label}
      {badge > 0 && (
        <span className="ml-auto rounded-full bg-warning/15 px-2 py-0.5 text-xs font-medium text-warning">
          {badge}
        </span>
      )}
    </Link>
  );
}

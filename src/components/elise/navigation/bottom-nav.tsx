"use client";

import {
  Brain,
  CalendarClock,
  History,
  House,
  LayoutGrid,
  LogOut,
  Menu as MenuIcon,
  Plug,
  Settings,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

import { Dialog } from "@/components/ui/dialog";
import { signOut } from "@/features/auth/actions";
import { useActiveThread, useHomeNavClick } from "@/features/chat/continuity";
import { homeHref } from "@/lib/active-thread";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

import { useMyEliseModules } from "./modules-context";
import { activeSection, myEliseItems } from "./nav-items";
import type { NavUser } from "./top-nav";

/**
 * Phone navigation (ADR-066): five destinations at the bottom, within thumb reach — Inicio,
 * Historial, Conocimiento, Mi ELISE and Más. Mi ELISE opens the person's modules; Más holds
 * Conexiones, Programados, Aprobaciones and Configuración. Never actions, never hidden behind a
 * hamburger. It steps aside while the keyboard is open.
 */
export function BottomNav({ user, pendingApprovals }: { user: NavUser; pendingApprovals: number }) {
  const { t } = useI18n();
  const pathname = usePathname();
  const active = activeSection(pathname);
  const home = homeHref(useActiveThread());
  const homeClick = useHomeNavClick(active === "home");
  const [sheet, setSheet] = useState<"modules" | "more" | null>(null);
  useKeyboardState();

  // A destination chosen in a sheet closes it.
  const [lastPath, setLastPath] = useState(pathname);
  if (pathname !== lastPath) {
    setLastPath(pathname);
    setSheet(null);
  }

  const more =
    active === "connections" ||
    active === "schedules" ||
    active === "settings" ||
    active === "approvals";

  return (
    <>
      <nav
        data-bottom-nav
        aria-label={t.nav.mainNavigation}
        className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-bg/90 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl lg:hidden"
      >
        <ul className="mx-auto grid h-[58px] max-w-lg grid-cols-5">
          <Tab
            href={home}
            onClick={homeClick}
            icon={House}
            label={t.nav.home}
            current={active === "home"}
          />
          <Tab href="/chat" icon={History} label={t.nav.chat} current={active === "chat"} />
          <Tab
            href="/knowledge"
            icon={Brain}
            label={t.nav.knowledge}
            current={active === "knowledge"}
          />
          <Tab
            icon={LayoutGrid}
            label={t.nav.myElise}
            current={active === "myElise"}
            expanded={sheet === "modules"}
            onPress={() => setSheet("modules")}
          />
          <Tab
            icon={MenuIcon}
            label={t.common.more}
            current={more}
            expanded={sheet === "more"}
            badge={pendingApprovals > 0}
            onPress={() => setSheet("more")}
          />
        </ul>
      </nav>
      <ModulesSheet open={sheet === "modules"} onClose={() => setSheet(null)} />
      <MoreSheet
        open={sheet === "more"}
        onClose={() => setSheet(null)}
        user={user}
        pendingApprovals={pendingApprovals}
        active={active}
      />
    </>
  );
}

function Tab({
  href,
  onClick,
  onPress,
  icon: Icon,
  label,
  current,
  expanded,
  badge,
}: {
  href?: string;
  onClick?: (e: React.MouseEvent<HTMLAnchorElement>) => void;
  onPress?: () => void;
  icon: LucideIcon;
  label: string;
  current: boolean;
  expanded?: boolean;
  badge?: boolean;
}) {
  const body = (
    <>
      <span className="relative">
        <Icon className="size-[21px]" strokeWidth={current ? 1.9 : 1.6} aria-hidden />
        {badge && (
          <span
            aria-hidden
            className="absolute -top-0.5 -right-1 size-2 rounded-full bg-approval ring-2 ring-bg"
          />
        )}
      </span>
      <span className="max-w-full truncate px-0.5 text-[10.5px] leading-none tracking-[0.01em]">
        {label}
      </span>
    </>
  );
  const cls = cn(
    "flex h-full w-full flex-col items-center justify-center gap-1 transition-colors focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none focus-visible:ring-inset",
    current ? "text-accent-text" : "text-muted active:text-fg",
  );
  return (
    <li className="min-w-0">
      {href ? (
        <Link
          href={href}
          onClick={onClick}
          aria-current={current ? "page" : undefined}
          className={cls}
        >
          {body}
        </Link>
      ) : (
        <button
          type="button"
          aria-haspopup="dialog"
          aria-expanded={expanded}
          aria-current={current ? "page" : undefined}
          onClick={onPress}
          className={cls}
        >
          {body}
        </button>
      )}
    </li>
  );
}

function ModulesSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useI18n();
  const items = myEliseItems(useMyEliseModules());
  return (
    <Dialog open={open} onClose={onClose} title={t.nav.myElise}>
      {items.length ? (
        <ul className="grid grid-cols-3 gap-2">
          {items.map((m) => (
            <li key={m.key}>
              <Link
                href={m.href}
                className="flex h-20 flex-col items-center justify-center gap-2 rounded-2xl border border-border bg-surface text-[13.5px] active:bg-surface-2"
              >
                <m.icon className="size-5 text-accent-text" strokeWidth={1.7} aria-hidden />
                <span className="max-w-full truncate px-1">{t.capabilities[m.key]}</span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[15px] text-muted">{t.myEliseModules.none}</p>
      )}
      <Link
        href="/connections#mi-elise"
        className={cn(
          "flex h-11 items-center justify-center rounded-full text-[14px]",
          items.length ? "text-muted" : "border border-accent/50 text-accent-text",
        )}
      >
        {items.length ? t.myEliseModules.manage : t.myEliseModules.choose}
      </Link>
    </Dialog>
  );
}

function MoreSheet({
  open,
  onClose,
  user,
  pendingApprovals,
  active,
}: {
  open: boolean;
  onClose: () => void;
  user: NavUser;
  pendingApprovals: number;
  active: ReturnType<typeof activeSection>;
}) {
  const { t } = useI18n();
  const rows: { href: string; icon: LucideIcon; label: string; key: string; note?: string }[] = [
    { key: "connections", href: "/connections", icon: Plug, label: t.nav.connections },
    { key: "schedules", href: "/schedules", icon: CalendarClock, label: t.nav.schedules },
    ...(pendingApprovals > 0
      ? [
          {
            key: "approvals",
            href: "/approvals",
            icon: ShieldCheck,
            label: t.nav.pendingApprovals(pendingApprovals),
          },
        ]
      : []),
    { key: "settings", href: "/settings", icon: Settings, label: t.nav.settings },
  ];
  return (
    <Dialog open={open} onClose={onClose} title={t.common.more}>
      <ul className="-mx-2 -mt-2 flex flex-col">
        {rows.map((r) => (
          <li key={r.key}>
            <Link
              href={r.href}
              aria-current={active === r.key ? "page" : undefined}
              className={cn(
                "flex h-13 items-center gap-3 rounded-2xl px-3 text-[16px] active:bg-surface-2",
                r.key === "approvals" ? "text-approval-text" : "text-fg",
                active === r.key && "bg-active",
              )}
            >
              <r.icon className="size-[19px] opacity-80" strokeWidth={1.7} aria-hidden />
              {r.label}
            </Link>
          </li>
        ))}
      </ul>
      <div className="flex items-center gap-3 border-t border-border pt-4">
        <span className="grid size-9 place-items-center rounded-full border border-border-strong text-[13px] font-medium">
          {user.initial}
        </span>
        <span className="min-w-0 flex-1 truncate text-[15px]">{user.name}</span>
        <form action={signOut}>
          <button
            type="submit"
            className="inline-flex h-11 items-center gap-2 rounded-full px-3 text-[14px] text-muted"
          >
            <LogOut className="size-4" aria-hidden />
            {t.nav.signOut}
          </button>
        </form>
      </div>
    </Dialog>
  );
}

/**
 * Whether the on-screen keyboard is open, for the layout: `data-keyboard="open"` on <html>
 * (the navigation steps aside) and `--keyboard-inset`, the part of the layout the keyboard
 * covers where the browser doesn't resize it (iOS Safari), so the dock stays above it.
 */
function useKeyboardState() {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const root = document.documentElement;
    const update = () => {
      const covered = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      const editing =
        document.activeElement instanceof HTMLElement &&
        document.activeElement.matches("input, textarea, select, [contenteditable='true']");
      // A keyboard: a field has focus and the visible area shrank a lot (rotations don't count).
      const open = editing && (covered > 120 || vv.height < window.screen.height * 0.6);
      root.dataset.keyboard = open ? "open" : "closed";
      root.style.setProperty("--keyboard-inset", `${Math.round(covered)}px`);
    };
    // Focus has moved by the time the blur settles.
    const later = () => setTimeout(update, 50);
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    window.addEventListener("focusin", update);
    window.addEventListener("focusout", later);
    update();
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      window.removeEventListener("focusin", update);
      window.removeEventListener("focusout", later);
    };
  }, []);
}

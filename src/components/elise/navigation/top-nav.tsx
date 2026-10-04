"use client";

import { AnimatePresence, motion } from "motion/react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { signOut } from "@/features/auth/actions";
import { useActiveThread, useHomeNavClick } from "@/features/chat/continuity";
import { useIsDesktop } from "@/hooks/use-is-desktop";
import { homeHref } from "@/lib/active-thread";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

import { ChevronDownIcon, SettingsIcon } from "../icons";
import { activeSection, MY_ELISE, SECTIONS } from "./nav-items";
import { Orb } from "../orb/orb";
import { ORB_FLIGHT, ORB_LAYOUT_ID, useOrbPresence } from "../orb/orb-presence";

export interface NavUser {
  name: string;
  initial: string;
  email: string | null;
}

const pill =
  "flex h-10 items-center rounded-full px-4 text-[13.5px] transition-colors duration-[var(--dur-xs)] hover:text-fg";

/**
 * Desktop top navigation (reference "Navigation — desktop states"): brand · pill nav · settings/account.
 * In a conversation it collapses to the current section after 24 px of scroll; hover, focus or
 * click expands it. The live mini-orb replaces the brand dot once the Orb has docked.
 */
export function TopNav({ user, pendingApprovals }: { user: NavUser; pendingApprovals: number }) {
  const { t } = useI18n();
  const pathname = usePathname();
  const active = activeSection(pathname);
  const home = homeHref(useActiveThread());
  const onHomeClick = useHomeNavClick(active === "home");
  const { state: orbState, docked, level, receded } = useOrbPresence();
  // The nav is hidden below md; only fly the Orb into it where it is visible.
  const desktop = useIsDesktop();
  const [scrolled, setScrolled] = useState(false);
  const [engaged, setEngaged] = useState(false);
  const [menu, setMenu] = useState<"myElise" | "account" | null>(null);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const collapsed = docked && scrolled && !engaged && menu === null;
  const activeLabel =
    active === "myElise" || active === "settings" || active === "approvals"
      ? t.nav[active]
      : t.nav[active ?? "home"];

  return (
    <header className="sticky top-0 z-40 hidden h-20 grid-cols-[1fr_auto_1fr] items-center bg-bg/80 px-10 backdrop-blur-md md:grid">
      <Link
        href={home}
        className="flex h-11 items-center gap-3 justify-self-start"
        aria-label="ELISE"
      >
        {docked && desktop ? (
          <motion.div
            layoutId={ORB_LAYOUT_ID}
            transition={ORB_FLIGHT}
            className="-mr-1.5 -ml-3 size-10"
          >
            <Orb state={orbState} size={40} levelSource={level} />
          </motion.div>
        ) : (
          <span
            aria-hidden
            className="size-2 rounded-full bg-accent shadow-[0_0_14px_var(--accent)]"
          />
        )}
        <span className="text-[13px] font-medium tracking-[0.34em]">ELISE</span>
      </Link>

      <div
        className={cn(
          "transition-opacity duration-[var(--dur-md)]",
          receded && !engaged && menu === null && "opacity-[0.42]",
        )}
        onPointerEnter={() => setEngaged(true)}
        onPointerLeave={() => setEngaged(false)}
        onFocus={() => setEngaged(true)}
        onBlur={(e) => !e.currentTarget.contains(e.relatedTarget) && setEngaged(false)}
      >
        <AnimatePresence mode="popLayout" initial={false}>
          {collapsed ? (
            <motion.button
              key="compact"
              layout
              type="button"
              onClick={() => setEngaged(true)}
              aria-expanded="false"
              aria-label={t.nav.openNavigationCurrent(activeLabel)}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
              className="flex h-12 items-center gap-2.5 rounded-full border border-border bg-glass pr-3.5 pl-5 text-[13.5px] backdrop-blur-xl"
            >
              {activeLabel}
              <ChevronDownIcon className="opacity-70" />
            </motion.button>
          ) : (
            <motion.nav
              key="full"
              layout
              aria-label={t.nav.mainNavigation}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
              className="flex items-center gap-0.5 rounded-full border border-border bg-glass p-1 backdrop-blur-xl"
            >
              {SECTIONS.map((s) => (
                <Link
                  key={s.key}
                  href={s.key === "home" ? home : s.href}
                  onClick={s.key === "home" ? onHomeClick : undefined}
                  aria-current={active === s.key ? "page" : undefined}
                  className={cn(pill, active === s.key ? "bg-active text-fg" : "text-muted")}
                >
                  {t.nav[s.key]}
                </Link>
              ))}
              <MyEliseMenu
                open={menu === "myElise"}
                onOpenChange={(o) => setMenu(o ? "myElise" : null)}
                current={active === "myElise"}
              />
            </motion.nav>
          )}
        </AnimatePresence>
      </div>

      <div className="flex items-center gap-2 justify-self-end">
        {pendingApprovals > 0 && (
          <Link
            href="/approvals"
            aria-current={active === "approvals" ? "page" : undefined}
            className="flex h-11 items-center gap-2 rounded-full px-3 text-[13px] text-approval-text hover:bg-active"
          >
            <span aria-hidden className="size-1.5 rounded-full bg-approval" />
            {t.nav.pendingApprovals(pendingApprovals)}
          </Link>
        )}
        <Link
          href="/settings"
          aria-label={t.nav.settings}
          aria-current={active === "settings" ? "page" : undefined}
          className={cn(
            "grid size-11 place-items-center rounded-full transition-colors hover:text-fg",
            active === "settings" ? "bg-active text-fg" : "text-muted",
          )}
        >
          <SettingsIcon />
        </Link>
        <AccountMenu
          user={user}
          open={menu === "account"}
          onOpenChange={(o) => setMenu(o ? "account" : null)}
        />
      </div>
    </header>
  );
}

function MyEliseMenu({
  open,
  onOpenChange,
  current,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  current: boolean;
}) {
  const { t } = useI18n();
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open)
      list.current
        ?.querySelector<HTMLElement>("[role=menuitem]:not([aria-disabled=true])")
        ?.focus();
  }, [open]);

  function close(returnFocus: boolean) {
    onOpenChange(false);
    if (returnFocus) trigger.current?.focus();
  }

  function onMenuKey(e: KeyboardEvent<HTMLDivElement>) {
    const items = [...(list.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Escape") {
      e.preventDefault();
      close(true);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = (i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
    }
  }

  return (
    <div
      className="relative"
      onBlur={(e) => open && !e.currentTarget.contains(e.relatedTarget) && close(false)}
    >
      <button
        ref={trigger}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-current={current ? "page" : undefined}
        onClick={() => onOpenChange(!open)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            onOpenChange(true);
          }
        }}
        className={cn(pill, "gap-1.5 pr-3.5", current || open ? "bg-active text-fg" : "text-muted")}
      >
        {t.nav.myElise}
        <ChevronDownIcon
          className={cn("transition-transform duration-[var(--dur-xs)]", open && "rotate-180")}
        />
      </button>
      <AnimatePresence>
        {open && (
          <MenuPanel
            ref={list}
            label={t.nav.myElise}
            onKeyDown={onMenuKey}
            className="-right-1 w-58"
          >
            <div className="flex h-7.5 items-center px-3 type-label text-faint">
              {t.nav.myElise}
            </div>
            {MY_ELISE.map((m) =>
              m.href ? (
                <Link
                  key={m.key}
                  href={m.href}
                  role="menuitem"
                  onClick={() => close(false)}
                  className="flex h-10 items-center gap-2.5 rounded-[10px] px-3 text-[13.5px] text-fg hover:bg-active focus-visible:bg-active"
                >
                  <m.icon className="size-4 text-muted" aria-hidden />
                  {t.capabilities[m.key]}
                </Link>
              ) : (
                <span
                  key={m.key}
                  role="menuitem"
                  aria-disabled="true"
                  tabIndex={-1}
                  className="flex h-10 items-center justify-between rounded-[10px] px-3 text-[13.5px] text-muted"
                >
                  <span className="flex items-center gap-2.5">
                    <m.icon className="size-4" aria-hidden />
                    {t.capabilities[m.key]}
                  </span>
                  <span className="type-label text-faint">{t.nav.soon}</span>
                </span>
              ),
            )}
          </MenuPanel>
        )}
      </AnimatePresence>
    </div>
  );
}

function AccountMenu({
  user,
  open,
  onOpenChange,
}: {
  user: NavUser;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useI18n();
  return (
    <div
      className="relative"
      onBlur={(e) => open && !e.currentTarget.contains(e.relatedTarget) && onOpenChange(false)}
    >
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t.nav.account(user.name)}
        onClick={() => onOpenChange(!open)}
        onKeyDown={(e) => e.key === "Escape" && onOpenChange(false)}
        className="grid size-11 place-items-center rounded-full"
      >
        <span className="grid size-8 place-items-center rounded-full border border-border-strong text-[12.5px] font-medium">
          {user.initial}
        </span>
      </button>
      <AnimatePresence>
        {open && (
          <MenuPanel
            label={t.nav.account(user.name)}
            className="right-0 w-64"
            onKeyDown={(e) => e.key === "Escape" && onOpenChange(false)}
          >
            <div className="px-3 py-2">
              <p className="text-[13.5px]">{user.name}</p>
              {user.email && <p className="truncate text-xs text-muted">{user.email}</p>}
            </div>
            <form action={signOut}>
              <button
                type="submit"
                role="menuitem"
                className="flex h-10 w-full items-center rounded-[10px] px-3 text-left text-[13.5px] text-muted hover:bg-active hover:text-fg"
              >
                {t.nav.signOut}
              </button>
            </form>
          </MenuPanel>
        )}
      </AnimatePresence>
    </div>
  );
}

/** Menu surface: in 160 ms (fade, 4 px drop, scale 0.98 → 1), out 120 ms fade (motion spec). */
function MenuPanel({
  ref,
  label,
  className,
  onKeyDown,
  children,
}: {
  ref?: React.Ref<HTMLDivElement>;
  label: string;
  className?: string;
  onKeyDown?: (e: KeyboardEvent<HTMLDivElement>) => void;
  children: ReactNode;
}) {
  return (
    <motion.div
      ref={ref}
      role="menu"
      aria-label={label}
      onKeyDown={onKeyDown}
      initial={{ opacity: 0, y: -4, scale: 0.98 }}
      animate={{
        opacity: 1,
        y: 0,
        scale: 1,
        transition: { duration: 0.16, ease: [0.22, 1, 0.36, 1] },
      }}
      exit={{ opacity: 0, transition: { duration: 0.12, ease: [0.4, 0, 1, 1] } }}
      style={{ transformOrigin: "top right" }}
      className={cn(
        "absolute top-13 z-50 flex flex-col gap-0.5 rounded-2xl border border-border bg-[var(--menu-bg)] p-1.5 shadow-[var(--menu-shadow)] backdrop-blur-xl",
        className,
      )}
    >
      {children}
    </motion.div>
  );
}

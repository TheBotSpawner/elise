"use client";

import { AnimatePresence, motion } from "motion/react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { signOut } from "@/features/auth/actions";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

import { ChevronDownIcon, CloseIcon, ComposeIcon, MenuIcon, SettingsIcon } from "../icons";
import { activeSection, MY_ELISE, SECTIONS } from "./nav-items";
import type { NavUser } from "./top-nav";
import { Orb } from "../orb/orb";
import { useOrbPresence } from "../orb/orb-presence";

const EASE = [0.22, 1, 0.36, 1] as const;

/**
 * Mobile header (reference "Mobile — Home/Chat"): menu · ELISE · account (or new conversation
 * inside a conversation, with the live mini-orb next to the wordmark).
 */
export function MobileHeader({
  user,
  pendingApprovals,
}: {
  user: NavUser;
  pendingApprovals: number;
}) {
  const { t } = useI18n();
  const pathname = usePathname();
  const { state: orbState, docked } = useOrbPresence();
  const [open, setOpen] = useState(false);

  // Close the overlay after navigating.
  const [lastPath, setLastPath] = useState(pathname);
  if (pathname !== lastPath) {
    setLastPath(pathname);
    setOpen(false);
  }

  return (
    <>
      <header
        className={cn(
          "sticky top-0 z-40 flex h-15 items-center justify-between bg-bg/85 px-2 backdrop-blur-md md:hidden",
          docked && "border-b border-border",
        )}
      >
        <button
          type="button"
          aria-label={t.nav.openNavigation}
          aria-expanded={open}
          onClick={() => setOpen(true)}
          className="relative grid size-11 place-items-center text-fg"
        >
          <MenuIcon />
          {pendingApprovals > 0 && (
            <span
              aria-hidden
              className="absolute top-2.5 right-2 size-1.5 rounded-full bg-approval"
            />
          )}
        </button>
        <Link href="/" className="flex items-center gap-1" aria-label="ELISE">
          {docked && <Orb state={orbState} size={36} />}
          <span className="pl-[0.34em] text-xs font-medium tracking-[0.34em]">ELISE</span>
        </Link>
        {docked ? (
          <Link
            href="/"
            aria-label={t.nav.newConversation}
            className="grid size-11 place-items-center text-muted"
          >
            <ComposeIcon />
          </Link>
        ) : (
          <Link
            href="/settings"
            aria-label={t.nav.account(user.name)}
            className="grid size-11 place-items-center"
          >
            <span className="grid size-7.5 place-items-center rounded-full border border-border-strong text-xs font-medium">
              {user.initial}
            </span>
          </Link>
        )}
      </header>
      <AnimatePresence>
        {open && (
          <MobileNavOverlay
            user={user}
            pendingApprovals={pendingApprovals}
            pathname={pathname}
            onClose={() => setOpen(false)}
          />
        )}
      </AnimatePresence>
    </>
  );
}

/** Full-screen overlay: in 320 ms (fade + translateY −12 → 0), items stagger 30 ms; out 240 ms. */
function MobileNavOverlay({
  user,
  pendingApprovals,
  pathname,
  onClose,
}: {
  user: NavUser;
  pendingApprovals: number;
  pathname: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const active = activeSection(pathname);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [modulesOpen, setModulesOpen] = useState(active === "myElise");

  useEffect(() => {
    closeRef.current?.focus();
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const item = (i: number) => ({
    initial: { opacity: 0, y: -6 },
    animate: { opacity: 1, y: 0, transition: { duration: 0.32, ease: EASE, delay: i * 0.03 } },
  });
  const big = "flex h-13 items-center rounded-[14px] px-3.5 text-xl font-light tracking-[-0.01em]";

  return (
    <motion.div
      role="dialog"
      aria-modal="true"
      aria-label={t.nav.mainNavigation}
      initial={{ opacity: 0, y: -12 }}
      animate={{ opacity: 1, y: 0, transition: { duration: 0.32, ease: EASE } }}
      exit={{ opacity: 0, y: -12, transition: { duration: 0.24, ease: [0.4, 0, 1, 1] } }}
      className="fixed inset-0 z-50 flex flex-col bg-[var(--overlay-bg)] md:hidden"
    >
      <div className="flex h-15 shrink-0 items-center justify-between pr-2 pl-5">
        <div className="flex items-center gap-3">
          <span
            aria-hidden
            className="size-2 rounded-full bg-accent shadow-[0_0_14px_var(--accent)]"
          />
          <span className="text-xs font-medium tracking-[0.34em]">ELISE</span>
        </div>
        <button
          ref={closeRef}
          type="button"
          aria-label={t.nav.closeNavigation}
          onClick={onClose}
          className="grid size-11 place-items-center"
        >
          <CloseIcon />
        </button>
      </div>

      <nav
        aria-label={t.nav.mainNavigation}
        className="flex flex-col gap-0.5 overflow-y-auto px-3 pt-5"
      >
        {SECTIONS.map((s, i) => (
          <motion.div key={s.key} {...item(i)}>
            <Link
              href={s.href}
              aria-current={active === s.key ? "page" : undefined}
              className={cn(
                big,
                "justify-between",
                active === s.key ? "bg-active text-fg" : "text-fg/75",
              )}
            >
              {t.nav[s.key]}
              {active === s.key && <span aria-hidden className="size-1.5 rounded-full bg-accent" />}
            </Link>
          </motion.div>
        ))}
        <motion.div {...item(SECTIONS.length)}>
          <button
            type="button"
            aria-expanded={modulesOpen}
            onClick={() => setModulesOpen((o) => !o)}
            className={cn(big, "w-full justify-between text-left text-fg")}
          >
            {t.nav.myElise}
            <ChevronDownIcon
              width={16}
              height={16}
              className={cn("transition-transform", modulesOpen && "rotate-180")}
            />
          </button>
          {modulesOpen && (
            <div className="grid grid-cols-3 gap-2 px-3.5 pt-1 pb-2.5">
              {MY_ELISE.map((m) =>
                m.href ? (
                  <Link
                    key={m.key}
                    href={m.href}
                    className="flex h-11 items-center justify-center rounded-xl border border-border text-sm"
                  >
                    {t.capabilities[m.key]}
                  </Link>
                ) : (
                  <span
                    key={m.key}
                    aria-disabled="true"
                    className="flex h-11 flex-col items-center justify-center rounded-xl border border-border text-sm text-muted"
                  >
                    {t.capabilities[m.key]}
                  </span>
                ),
              )}
            </div>
          )}
        </motion.div>
      </nav>

      <div className="mt-auto flex flex-col gap-0.5 px-3 pb-7">
        <div className="mx-3.5 mb-2.5 h-px bg-border" />
        {pendingApprovals > 0 && (
          <Link
            href="/approvals"
            className="flex h-12 items-center gap-3 rounded-[14px] px-3.5 text-[15px] text-approval-text"
          >
            <span aria-hidden className="size-1.5 rounded-full bg-approval" />
            {t.nav.pendingApprovals(pendingApprovals)}
          </Link>
        )}
        <Link
          href="/settings"
          className="flex h-12 items-center gap-3 rounded-[14px] px-3.5 text-[15px] text-fg/75"
        >
          <SettingsIcon width={18} height={18} />
          {t.nav.settings}
        </Link>
        <div className="flex h-13 items-center gap-3 px-3.5">
          <span className="grid size-7.5 place-items-center rounded-full border border-border-strong text-xs font-medium">
            {user.initial}
          </span>
          <span className="flex-1 truncate text-sm">{user.name}</span>
          <form action={signOut}>
            <button type="submit" className="h-11 px-2 text-sm text-muted">
              {t.nav.signOut}
            </button>
          </form>
        </div>
      </div>
    </motion.div>
  );
}

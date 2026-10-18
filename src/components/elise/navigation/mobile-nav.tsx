"use client";

import { Bell } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

import { Dialog } from "@/components/ui/dialog";
import { Ambient } from "@/features/chat/chat-surface";
import { NewChatButton, useActiveThread } from "@/features/chat/continuity";
import { noticeCount, useHomeNotices } from "@/features/chat/home-notices";
import { homeHref } from "@/lib/active-thread";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

import { activeSection } from "./nav-items";
import type { NavUser } from "./top-nav";
import { Orb } from "../orb/orb";
import { useOrbPresence } from "../orb/orb-presence";

/**
 * Phone header (ADR-066): compact, under the notch — ELISE in the middle, and in the corner a new
 * conversation (inside one) or the account. Navigation lives in the bottom bar.
 */
/**
 * Home's news on phones (ADR-077): Morning Brief, Continuar, Vencidas… behind a bell next to the
 * profile — the Orb keeps the screen. A dot when something is new; nothing when there's nothing.
 */
function HomeNoticesBell() {
  const { t } = useI18n();
  const ambient = useHomeNotices();
  const [open, setOpen] = useState(false);
  const count = noticeCount(ambient);
  if (!ambient || !count) return null;
  return (
    <>
      <button
        type="button"
        aria-label={t.home.notices(count)}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
        className="relative grid size-11 place-items-center text-muted hover:text-fg"
      >
        <Bell className="size-[19px]" strokeWidth={1.75} aria-hidden />
        <span
          aria-hidden
          className="absolute top-2.5 right-2.5 size-2 rounded-full bg-accent ring-2 ring-bg"
        />
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title={t.home.noticesTitle}>
        {/* Following a link closes the sheet. */}
        <div onClickCapture={(e) => (e.target as HTMLElement).closest("a") && setOpen(false)}>
          <Ambient ambient={ambient} />
        </div>
      </Dialog>
    </>
  );
}

export function MobileHeader({ user }: { user: NavUser }) {
  const { t } = useI18n();
  const pathname = usePathname();
  const { state: orbState, docked, level } = useOrbPresence();
  const activeThread = useActiveThread();
  const home = homeHref(activeThread);
  // In a conversation (the tab's active one, on Home), the corner offers a new one.
  const inConversation = docked || (activeThread !== null && activeSection(pathname) === "home");

  return (
    <header
      className={cn(
        "sticky top-0 z-40 bg-bg/85 pt-[env(safe-area-inset-top)] backdrop-blur-md lg:hidden",
        docked && "border-b border-border",
      )}
    >
      <div className="grid h-13 grid-cols-[88px_1fr_88px] items-center px-2">
        <span aria-hidden />
        <Link
          href={home}
          className="flex h-11 items-center justify-center gap-1 justify-self-center px-3"
          aria-label="ELISE"
        >
          {docked && <Orb state={orbState} size={32} levelSource={level} />}
          <span className="pl-[0.34em] text-xs font-medium tracking-[0.34em]">ELISE</span>
        </Link>
        <div className="flex items-center justify-self-end">
          {!inConversation && <HomeNoticesBell />}
          {inConversation ? (
            <NewChatButton variant="icon" />
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
        </div>
      </div>
    </header>
  );
}

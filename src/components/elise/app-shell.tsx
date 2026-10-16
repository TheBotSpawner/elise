"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef, type ReactNode } from "react";

import { MyEliseModulesProvider } from "@/components/elise/navigation/modules-context";
import type { NativeModuleKey } from "@/core/modules/registry";
import { MusicController } from "@/features/music/music-view";
import { useRealtimeRefresh } from "@/hooks/use-realtime-refresh";

import { BottomNav } from "./navigation/bottom-nav";
import { MobileHeader } from "./navigation/mobile-nav";
import { TopNav, type NavUser } from "./navigation/top-nav";
import { skipBoot } from "./orb/boot";
import { OrbPresenceProvider } from "./orb/orb-presence";

/**
 * Authenticated frame: top navigation from `lg`; on phones and portrait tablets a compact header
 * and the bottom navigation (ADR-066). One shared Orb presence.
 */
export function AppShell({
  workspaceId,
  pendingApprovals,
  user,
  modules,
  children,
}: {
  workspaceId: string;
  pendingApprovals: number;
  user: NavUser;
  /** The Mi ELISE modules this person uses, in order (ADR-064). */
  modules: readonly NativeModuleKey[];
  children: ReactNode;
}) {
  useRealtimeRefresh(workspaceId, ["approvals", "notifications"]);
  // Boot belongs to entering ELISE at Home (ADR-046). Entering anywhere else, this document has
  // no startup sequence: later visits to Home don't replay it. Runs after the page's own
  // effects, so a Home Orb has already claimed its boot by then.
  const pathname = usePathname();
  const entry = useRef(pathname);
  useEffect(() => {
    if (entry.current !== "/") skipBoot();
  }, []);

  return (
    <MyEliseModulesProvider modules={modules}>
      <OrbPresenceProvider>
        <div className="relative flex min-h-dvh flex-col">
          <TopNav user={user} pendingApprovals={pendingApprovals} />
          <MobileHeader user={user} />
          {/* Phones: room for the bottom navigation under the content (ADR-066). */}
          <div className="flex min-w-0 flex-1 flex-col pb-[var(--bottom-nav-h)]">{children}</div>
          <BottomNav user={user} pendingApprovals={pendingApprovals} />
        </div>
        {/* Music (ADR-042): one canonical player state for every page. */}
        <MusicController />
      </OrbPresenceProvider>
    </MyEliseModulesProvider>
  );
}

"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef, type ReactNode } from "react";

import { MusicController } from "@/features/music/music-view";
import { useRealtimeRefresh } from "@/hooks/use-realtime-refresh";

import { MobileHeader } from "./navigation/mobile-nav";
import { TopNav, type NavUser } from "./navigation/top-nav";
import { skipBoot } from "./orb/boot";
import { OrbPresenceProvider } from "./orb/orb-presence";

/** Authenticated frame: top navigation (mobile header + overlay below md), one shared Orb presence. */
export function AppShell({
  workspaceId,
  pendingApprovals,
  user,
  children,
}: {
  workspaceId: string;
  pendingApprovals: number;
  user: NavUser;
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
    <OrbPresenceProvider>
      <div className="relative flex min-h-dvh flex-col">
        <TopNav user={user} pendingApprovals={pendingApprovals} />
        <MobileHeader user={user} pendingApprovals={pendingApprovals} />
        <div className="flex min-w-0 flex-1 flex-col">{children}</div>
      </div>
      {/* Music (ADR-042): one canonical player state for every page. */}
      <MusicController />
    </OrbPresenceProvider>
  );
}

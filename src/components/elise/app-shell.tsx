"use client";

import type { ReactNode } from "react";

import { useRealtimeRefresh } from "@/hooks/use-realtime-refresh";

import { MobileHeader } from "./navigation/mobile-nav";
import { TopNav, type NavUser } from "./navigation/top-nav";
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

  return (
    <OrbPresenceProvider>
      <div className="relative flex min-h-dvh flex-col">
        <TopNav user={user} pendingApprovals={pendingApprovals} />
        <MobileHeader user={user} pendingApprovals={pendingApprovals} />
        <div className="flex min-w-0 flex-1 flex-col">{children}</div>
      </div>
    </OrbPresenceProvider>
  );
}

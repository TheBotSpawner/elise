"use client";

import { createContext, useContext, type ReactNode } from "react";

import type { DiscoveredDevice, DiscoveryStep } from "@/core/home/discovery";
import type { HomeHubLocalState } from "@/core/platform/platform";

/**
 * The managed Home runtime on this computer (ADR-082), as Hogar sees it. Only ELISE Desktop
 * provides one; on the web it's absent and Hogar shows the browser's setup instead. Shared code
 * never reaches for the Desktop bridge directly.
 */
export interface HomeRuntimeControls {
  state: HomeHubLocalState | null;
  setup(): Promise<void>;
  enableRequirements(): Promise<void>;
  restartComputer(): Promise<void>;
  reset(): Promise<void>;
  diagnostics(): Promise<string>;
  /** ADR-090: devices found on the network, added from Hogar. */
  discoveries(): Promise<DiscoveredDevice[]>;
  openDiscovery(flowId: string): Promise<DiscoveryStep>;
  answerDiscovery(
    flowId: string,
    answers: Record<string, string | number | boolean>,
  ): Promise<DiscoveryStep>;
  ignoreDiscovery(flowId: string, name: string): Promise<boolean>;
}

const HomeRuntimeContext = createContext<HomeRuntimeControls | null>(null);

export function HomeRuntimeProvider({
  value,
  children,
}: {
  value: HomeRuntimeControls;
  children: ReactNode;
}) {
  return <HomeRuntimeContext.Provider value={value}>{children}</HomeRuntimeContext.Provider>;
}

export const useHomeRuntime = () => useContext(HomeRuntimeContext);

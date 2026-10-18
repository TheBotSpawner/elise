"use client";

import { createContext, useContext, type ReactNode } from "react";

import {
  featureSupport,
  WEB_PLATFORM,
  type FeatureSupport,
  type PlatformCapability,
  type PlatformInfo,
} from "@/core/platform/platform";

/**
 * The surface ELISE is running on (ADR-081). The web never sets it (plain web capabilities);
 * ELISE Desktop provides its own. Product code asks for capabilities, never "is Electron".
 */
const PlatformContext = createContext<PlatformInfo>(WEB_PLATFORM);

export function PlatformProvider({
  platform,
  children,
}: {
  platform: PlatformInfo;
  children: ReactNode;
}) {
  return <PlatformContext.Provider value={platform}>{children}</PlatformContext.Provider>;
}

export const usePlatform = () => useContext(PlatformContext);

export function useFeature(need: {
  capability: PlatformCapability;
  minProtocol?: number;
}): FeatureSupport {
  return featureSupport(usePlatform(), need);
}

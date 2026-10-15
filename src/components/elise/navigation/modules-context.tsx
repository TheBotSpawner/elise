"use client";

import { createContext, useContext, type ReactNode } from "react";

import type { NativeModuleKey } from "@/core/modules/registry";

/**
 * The Mi ELISE modules this person uses (ADR-064), loaded once by the app layout. The database is
 * the source of truth: after a change the server re-renders the layout (router refresh).
 */
const ModulesContext = createContext<readonly NativeModuleKey[]>([]);

export function MyEliseModulesProvider({
  modules,
  children,
}: {
  modules: readonly NativeModuleKey[];
  children: ReactNode;
}) {
  return <ModulesContext.Provider value={modules}>{children}</ModulesContext.Provider>;
}

export const useMyEliseModules = () => useContext(ModulesContext);

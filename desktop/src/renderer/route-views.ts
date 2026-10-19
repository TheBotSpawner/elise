import type { ComponentType } from "react";

import { View as adminPerf } from "@/app/(app)/admin/perf/view";
import { View as adminUsage } from "@/app/(app)/admin/usage/view";
import { View as approvals } from "@/app/(app)/approvals/view";
import { View as chatId } from "@/app/(app)/chat/[id]/view";
import { View as chat } from "@/app/(app)/chat/view";
import { View as connectionsProvider } from "@/app/(app)/connections/[provider]/view";
import { View as connectionsSourcesId } from "@/app/(app)/connections/sources/[id]/view";
import { View as connectionsSourcesNew } from "@/app/(app)/connections/sources/new/view";
import { View as connections } from "@/app/(app)/connections/view";
import { View as downloadDesktop } from "@/app/(app)/download/desktop/view";
import { View as knowledgeItemsId } from "@/app/(app)/knowledge/items/[id]/view";
import { View as knowledgeSpacesId } from "@/app/(app)/knowledge/spaces/[id]/view";
import { View as knowledge } from "@/app/(app)/knowledge/view";
import { View as myEliseContextsId } from "@/app/(app)/my-elise/contexts/[id]/view";
import { View as myEliseContexts } from "@/app/(app)/my-elise/contexts/view";
import { View as myEliseFinanceConnect } from "@/app/(app)/my-elise/finance/connect/view";
import { View as myEliseFinanceImportId } from "@/app/(app)/my-elise/finance/import/[id]/view";
import { View as myEliseFinanceReports } from "@/app/(app)/my-elise/finance/reports/view";
import { View as myEliseFinanceSources } from "@/app/(app)/my-elise/finance/sources/view";
import { View as myEliseFinance } from "@/app/(app)/my-elise/finance/view";
import { View as myEliseGoals } from "@/app/(app)/my-elise/goals/view";
import { View as myEliseHabits } from "@/app/(app)/my-elise/habits/view";
import { View as myEliseListsId } from "@/app/(app)/my-elise/lists/[id]/view";
import { View as myEliseLists } from "@/app/(app)/my-elise/lists/view";
import { View as myEliseMethods } from "@/app/(app)/my-elise/methods/view";
import { View as myEliseNotes } from "@/app/(app)/my-elise/notes/view";
import { View as myEliseShortcuts } from "@/app/(app)/my-elise/shortcuts/view";
import { View as myEliseTasks } from "@/app/(app)/my-elise/tasks/view";
import { View as myEliseTime } from "@/app/(app)/my-elise/time/view";
import { View as myElise } from "@/app/(app)/my-elise/view";
import { View as schedulesResultsId } from "@/app/(app)/schedules/results/[id]/view";
import { View as schedules } from "@/app/(app)/schedules/view";
import { View as settingsAccount } from "@/app/(app)/settings/account/view";
import { View as settingsAppearance } from "@/app/(app)/settings/appearance/view";
import { View as settingsBilling } from "@/app/(app)/settings/billing/view";
import { View as settingsGeneral } from "@/app/(app)/settings/general/view";
import { View as settingsMemory } from "@/app/(app)/settings/memory/view";
import { View as settingsPersonality } from "@/app/(app)/settings/personality/view";
import { View as settingsShortcuts } from "@/app/(app)/settings/shortcuts/view";
import { View as settingsStorageCategory } from "@/app/(app)/settings/storage/[category]/view";
import { View as settingsStorage } from "@/app/(app)/settings/storage/view";
import { View as settingsUsage } from "@/app/(app)/settings/usage/view";
import { View as settings } from "@/app/(app)/settings/view";
import { View as settingsVoice } from "@/app/(app)/settings/voice/view";
import { View as onboarding } from "@/app/onboarding/view";
import type { AppRoute } from "@/core/platform/app-routes";

import { DesktopSettings } from "./screens";

/**
 * Each ELISE screen's view, by path (ADR-092): the web's own view component, fed by that route's
 * loader on ELISE Cloud (none for VIEW_ONLY_ROUTES). "/" and Hogar have dedicated routes. Kept
 * complete by tests/unit/desktop/route-inventory.test.ts.
 */
// Props come from that route's own loader (ROUTE_LOADERS); each pair is the same route's
// load.ts/view.tsx, so the shapes match by construction — there is no single prop type.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RouteView = ComponentType<any>;

export const ROUTE_VIEWS: Partial<Record<AppRoute, RouteView>> = {
  "/approvals": approvals,
  "/chat": chat,
  "/chat/[id]": chatId,
  "/connections": connections,
  "/connections/[provider]": connectionsProvider,
  "/connections/sources/new": connectionsSourcesNew,
  "/connections/sources/[id]": connectionsSourcesId,
  "/download/desktop": downloadDesktop,
  "/knowledge": knowledge,
  "/knowledge/items/[id]": knowledgeItemsId,
  "/knowledge/spaces/[id]": knowledgeSpacesId,
  "/my-elise": myElise,
  "/my-elise/contexts": myEliseContexts,
  "/my-elise/contexts/[id]": myEliseContextsId,
  "/my-elise/finance": myEliseFinance,
  "/my-elise/finance/connect": myEliseFinanceConnect,
  "/my-elise/finance/import/[id]": myEliseFinanceImportId,
  "/my-elise/finance/reports": myEliseFinanceReports,
  "/my-elise/finance/sources": myEliseFinanceSources,
  "/my-elise/goals": myEliseGoals,
  "/my-elise/habits": myEliseHabits,
  "/my-elise/lists": myEliseLists,
  "/my-elise/lists/[id]": myEliseListsId,
  "/my-elise/methods": myEliseMethods,
  "/my-elise/notes": myEliseNotes,
  "/my-elise/shortcuts": myEliseShortcuts,
  "/my-elise/tasks": myEliseTasks,
  "/my-elise/time": myEliseTime,
  "/schedules": schedules,
  "/schedules/results/[id]": schedulesResultsId,
  "/settings": settings,
  "/settings/account": settingsAccount,
  "/settings/appearance": settingsAppearance,
  "/settings/billing": settingsBilling,
  "/settings/general": settingsGeneral,
  "/settings/memory": settingsMemory,
  "/settings/personality": settingsPersonality,
  "/settings/shortcuts": settingsShortcuts,
  "/settings/storage": settingsStorage,
  "/settings/storage/[category]": settingsStorageCategory,
  "/settings/usage": settingsUsage,
  "/settings/voice": settingsVoice,
  "/admin/perf": adminPerf,
  "/admin/usage": adminUsage,
  "/onboarding": onboarding,
  "/settings/desktop": DesktopSettings,
};

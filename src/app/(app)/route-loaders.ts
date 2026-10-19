import type { AppRoute } from "@/core/platform/app-routes";

import { load as adminPerf } from "./admin/perf/load";
import { load as adminUsage } from "./admin/usage/load";
import { load as approvals } from "./approvals/load";
import { load as chatId } from "./chat/[id]/load";
import { load as chat } from "./chat/load";
import { load as onboarding } from "../onboarding/load";
import { load as connectionsProvider } from "./connections/[provider]/load";
import { load as connections } from "./connections/load";
import { load as connectionsSourcesId } from "./connections/sources/[id]/load";
import { load as connectionsSourcesNew } from "./connections/sources/new/load";
import { load as downloadDesktop } from "./download/desktop/load";
import { load as knowledgeItemsId } from "./knowledge/items/[id]/load";
import { load as knowledge } from "./knowledge/load";
import { load as knowledgeSpacesId } from "./knowledge/spaces/[id]/load";
import { load as myEliseContextsId } from "./my-elise/contexts/[id]/load";
import { load as myEliseContexts } from "./my-elise/contexts/load";
import { load as myEliseFinanceConnect } from "./my-elise/finance/connect/load";
import { load as myEliseFinanceImportId } from "./my-elise/finance/import/[id]/load";
import { load as myEliseFinance } from "./my-elise/finance/load";
import { load as myEliseFinanceReports } from "./my-elise/finance/reports/load";
import { load as myEliseFinanceSources } from "./my-elise/finance/sources/load";
import { load as myEliseGoals } from "./my-elise/goals/load";
import { load as myEliseHabits } from "./my-elise/habits/load";
import { load as myEliseListsId } from "./my-elise/lists/[id]/load";
import { load as myEliseLists } from "./my-elise/lists/load";
import { load as myElise } from "./my-elise/load";
import { load as myEliseMethods } from "./my-elise/methods/load";
import { load as myEliseNotes } from "./my-elise/notes/load";
import { load as myEliseShortcuts } from "./my-elise/shortcuts/load";
import { load as myEliseTasks } from "./my-elise/tasks/load";
import type { RouteLoader } from "./route-contract";
import { load as schedules } from "./schedules/load";
import { load as schedulesResultsId } from "./schedules/results/[id]/load";
import { load as settingsAccount } from "./settings/account/load";
import { load as settingsAppearance } from "./settings/appearance/load";
import { load as settingsGeneral } from "./settings/general/load";
import { load as settings } from "./settings/load";
import { load as settingsMemory } from "./settings/memory/load";
import { load as settingsPersonality } from "./settings/personality/load";
import { load as settingsShortcuts } from "./settings/shortcuts/load";
import { load as settingsStorageCategory } from "./settings/storage/[category]/load";
import { load as settingsStorage } from "./settings/storage/load";
import { load as settingsUsage } from "./settings/usage/load";
import { load as settingsVoice } from "./settings/voice/load";

/**
 * Each ELISE screen's loader, by path (ADR-092): what ELISE Cloud runs for Desktop's local
 * renderer — the very function the web page calls. VIEW_ONLY_ROUTES have none; "/" and Hogar
 * have dedicated handling. Kept complete by
 * tests/unit/desktop/route-inventory.test.ts.
 */
export const ROUTE_LOADERS: Partial<Record<AppRoute, RouteLoader<unknown>>> = {
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
  "/schedules": schedules,
  "/schedules/results/[id]": schedulesResultsId,
  "/settings": settings,
  "/settings/account": settingsAccount,
  "/settings/appearance": settingsAppearance,
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
};

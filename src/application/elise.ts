import "server-only";

import type { ExecutorPorts } from "@/core/agents/executor";
import {
  ToolRegistry,
  type ActionOrigin,
  type ProviderFactory,
  type ToolContext,
} from "@/core/agents/tools";
import type { CapabilityKey } from "@/core/capabilities/types";
import { AppError } from "@/core/errors";
import type { CapabilityBinding } from "@/core/providers/types";
import { TASK_TOOLS } from "@/core/tools/tasks";
import { EliseTasksProvider } from "@/infrastructure/providers/elise-native/tasks";
import { SupabaseActionLog } from "@/infrastructure/supabase/repositories/action-log";
import {
  loadWorkspaceBindings,
  type WorkspaceBindings,
} from "@/infrastructure/supabase/repositories/bindings";

import type { AuthContext } from "./auth-context";

/** Every tool ELISE can use. Exposure per run is filtered by available capabilities. */
export const toolRegistry = new ToolRegistry().register(...TASK_TOOLS);

/** Maps a resolved binding to the concrete provider adapter. */
function providerFactory(auth: AuthContext): ProviderFactory {
  return {
    get(capability, binding) {
      if (capability === "tasks" && binding.providerKey === "elise_native") {
        return new EliseTasksProvider(auth.db, auth.workspaceId, binding.connectionId);
      }
      throw new AppError(
        "CAPABILITY_UNAVAILABLE",
        `${binding.providerKey} does not implement ${capability} yet`,
      );
    },
  };
}

/** Wires ELISE Core's ports to Supabase-backed infrastructure for one authenticated request. */
export function createExecutorPorts(
  auth: AuthContext,
): ExecutorPorts & { bindings(): Promise<WorkspaceBindings> } {
  let loaded: Promise<WorkspaceBindings> | undefined;
  const bindings = () => (loaded ??= loadWorkspaceBindings(auth.db, auth.workspaceId));
  return {
    registry: toolRegistry,
    providers: providerFactory(auth),
    log: new SupabaseActionLog(auth.db),
    bindings,
    loadBindings: async () => (await bindings()).bindings,
    permissionFor: async (binding: CapabilityBinding) =>
      (await bindings()).permissions.get(`${binding.connectionId}:${binding.capability}`) ??
      "understand",
  };
}

export function toolContext(
  auth: AuthContext,
  origin: ActionOrigin,
  aiRunId: string | null = null,
): ToolContext {
  return {
    workspaceId: auth.workspaceId,
    userId: auth.userId,
    timezone: auth.profile.timezone,
    locale: auth.profile.locale,
    now: new Date(),
    origin,
    aiRunId,
  };
}

/** Capabilities with at least one enabled, healthy binding right now. */
export function availableCapabilities(bindings: readonly CapabilityBinding[]): Set<CapabilityKey> {
  return new Set(
    bindings
      .filter((b) => b.enabled && b.connectionStatus === "connected")
      .map((b) => b.capability),
  );
}

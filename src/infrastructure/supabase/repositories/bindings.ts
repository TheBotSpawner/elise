import type { CapabilityKey } from "@/core/capabilities/types";
import { AppError } from "@/core/errors";
import type {
  CapabilityBinding,
  ConnectionStatus,
  ContextType,
  ProviderKey,
} from "@/core/providers/types";

import type { ServerSupabase } from "../server";

export interface WorkspaceBindings {
  bindings: CapabilityBinding[];
  /** connectionId:capability → permission level */
  permissions: Map<string, "understand" | "read" | "write">;
}

/** Loads the workspace's bindings with their connection status and permission levels. */
export async function loadWorkspaceBindings(
  db: ServerSupabase,
  workspaceId: string,
): Promise<WorkspaceBindings> {
  const [bindingsRes, connectionsRes, capsRes] = await Promise.all([
    db.from("capability_bindings").select("*").eq("workspace_id", workspaceId),
    db
      .from("provider_connections")
      .select("id, provider_key, status")
      .eq("workspace_id", workspaceId),
    db
      .from("connection_capabilities")
      .select("connection_id, capability_key, enabled, permission_level")
      .eq("workspace_id", workspaceId),
  ]);
  const error = bindingsRes.error ?? connectionsRes.error ?? capsRes.error;
  if (error)
    throw new AppError("PROVIDER_UNAVAILABLE", "Could not load connections", { cause: error });

  const connections = new Map((connectionsRes.data ?? []).map((c) => [c.id, c]));
  const permissions = new Map<string, "understand" | "read" | "write">();
  const enabledCaps = new Set<string>();
  for (const c of capsRes.data ?? []) {
    if (!c.enabled) continue;
    enabledCaps.add(`${c.connection_id}:${c.capability_key}`);
    permissions.set(`${c.connection_id}:${c.capability_key}`, c.permission_level);
  }

  const bindings = (bindingsRes.data ?? []).flatMap((b): CapabilityBinding[] => {
    const connection = connections.get(b.connection_id);
    if (!connection) return [];
    return [
      {
        id: b.id,
        capability: b.capability_key as CapabilityKey,
        connectionId: b.connection_id,
        providerKey: connection.provider_key as ProviderKey,
        connectionStatus: connection.status as ConnectionStatus,
        contextType: b.context_type as ContextType | null,
        contextId: b.context_id,
        priority: b.priority,
        isDefault: b.is_default,
        // A binding is only usable if the capability is also enabled on its connection.
        enabled: b.enabled && enabledCaps.has(`${b.connection_id}:${b.capability_key}`),
      },
    ];
  });

  return { bindings, permissions };
}

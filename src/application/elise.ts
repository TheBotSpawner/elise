import "server-only";

import type { AccountSummary } from "@/core/agents/context";
import { executeToolCall, type ExecutorPorts } from "@/core/agents/executor";
import {
  ToolRegistry,
  type ActionOrigin,
  type CapabilityProviders,
  type ImplementedCapability,
  type ProviderFactory,
  type ToolContext,
} from "@/core/agents/tools";
import type { CapabilityKey } from "@/core/capabilities/types";
import { AppError } from "@/core/errors";
import type { CapabilityBinding } from "@/core/providers/types";
import { CALENDAR_TOOLS } from "@/core/tools/calendar";
import { EMAIL_TOOLS } from "@/core/tools/email";
import { TASK_TOOLS } from "@/core/tools/tasks";
import { logger } from "@/infrastructure/observability/logger";
import { EliseTasksProvider } from "@/infrastructure/providers/elise-native/tasks";
import { GoogleCalendarProvider } from "@/infrastructure/providers/google/calendar";
import { googleOAuthConfig } from "@/infrastructure/providers/google/config";
import { SupabaseCredentialVault } from "@/infrastructure/providers/google/connection-vault";
import {
  GoogleTokenProvider,
  type ConnectionRef,
} from "@/infrastructure/providers/google/credentials";
import { GmailProvider } from "@/infrastructure/providers/google/gmail";
import { GoogleHttp } from "@/infrastructure/providers/google/http";
import { GoogleTasksProvider } from "@/infrastructure/providers/google/tasks";
import { createAdminClient } from "@/infrastructure/supabase/admin";
import { SupabaseActionLog } from "@/infrastructure/supabase/repositories/action-log";
import {
  loadWorkspaceBindings,
  type WorkspaceBindings,
} from "@/infrastructure/supabase/repositories/bindings";

import type { AuthContext } from "./auth-context";

/** Every tool ELISE can use. Exposure per run is filtered by available capabilities. */
export const toolRegistry = new ToolRegistry().register(
  ...TASK_TOOLS,
  ...CALENDAR_TOOLS,
  ...EMAIL_TOOLS,
);

/**
 * A revoked/expired grant: stop using the connection for resolution (status), tell the user
 * once, and keep an audit trail. Never falls back to another account.
 */
async function markNeedsReauthorization(auth: AuthContext, ref: ConnectionRef, code: string) {
  const { data } = await auth.db
    .from("provider_connections")
    .update({
      status: "needs_reauthorization",
      last_error_code: code,
      last_error_at: new Date().toISOString(),
    })
    .eq("id", ref.connectionId)
    .eq("workspace_id", ref.workspaceId)
    .eq("status", "connected")
    .select("display_name")
    .maybeSingle();
  if (!data) return;
  logger.warn("connection.needs_reauthorization", { connection_id: ref.connectionId, code });
  await Promise.all([
    auth.db.from("notifications").insert({
      workspace_id: auth.workspaceId,
      user_id: auth.userId,
      notification_type: "connection.needs_attention",
      title: `Google “${data.display_name}” needs to be reconnected`,
      priority: "high",
      source_type: "provider_connection",
      source_id: ref.connectionId,
      action_url: "/connections",
    }),
    auth.db.from("audit_events").insert({
      workspace_id: auth.workspaceId,
      user_id: auth.userId,
      event_type: "connection.needs_reauthorization",
      resource_type: "provider_connection",
      resource_id: ref.connectionId,
      provider_key: "google",
      connection_id: ref.connectionId,
      origin: "system",
      result: "failure",
      metadata: { code },
    }),
  ]);
}

/** Maps a resolved binding to the concrete provider adapter. */
function providerFactory(
  auth: AuthContext,
  resolved: () => WorkspaceBindings | undefined,
): ProviderFactory {
  const google = new Map<string, GoogleHttp>();
  const googleHttp = (connectionId: string) => {
    let http = google.get(connectionId);
    if (!http) {
      const ref = { connectionId, workspaceId: auth.workspaceId };
      const tokens = new GoogleTokenProvider(ref, {
        vault: new SupabaseCredentialVault(createAdminClient(), "google"),
        config: googleOAuthConfig(),
        onReauthorizationRequired: (r, code) => markNeedsReauthorization(auth, r, code),
      });
      http = new GoogleHttp(tokens);
      google.set(connectionId, http);
    }
    return http;
  };

  const make: {
    [K in ImplementedCapability]: (binding: CapabilityBinding) => CapabilityProviders[K];
  } = {
    tasks(binding) {
      if (binding.providerKey === "elise_native") {
        return new EliseTasksProvider(auth.db, auth.workspaceId, binding.connectionId);
      }
      if (binding.providerKey === "google") {
        return new GoogleTasksProvider(
          { connectionId: binding.connectionId, label: binding.label },
          googleHttp(binding.connectionId),
        );
      }
      throw unsupported("tasks", binding);
    },
    calendar(binding) {
      if (binding.providerKey !== "google") throw unsupported("calendar", binding);
      // Default calendar for new events is binding configuration (set from Connections).
      const calendarId = resolved()?.configuration.get(binding.id)?.calendarId;
      return new GoogleCalendarProvider(
        {
          connectionId: binding.connectionId,
          label: binding.label,
          defaultCalendarId: typeof calendarId === "string" ? calendarId : null,
        },
        googleHttp(binding.connectionId),
      );
    },
    email(binding) {
      if (binding.providerKey !== "google") throw unsupported("email", binding);
      return new GmailProvider(
        { connectionId: binding.connectionId, label: binding.label, account: binding.accountLabel },
        googleHttp(binding.connectionId),
      );
    },
  };

  return {
    get<C extends ImplementedCapability>(capability: C, binding: CapabilityBinding) {
      return (make[capability] as (b: CapabilityBinding) => CapabilityProviders[C])(binding);
    },
  };
}

function unsupported(capability: string, binding: CapabilityBinding): AppError {
  return new AppError(
    "CAPABILITY_UNAVAILABLE",
    `${binding.providerKey} does not implement ${capability}`,
  );
}

/** Wires ELISE Core's ports to Supabase-backed infrastructure for one authenticated request. */
export function createExecutorPorts(
  auth: AuthContext,
): ExecutorPorts & { bindings(): Promise<WorkspaceBindings> } {
  let loaded: Promise<WorkspaceBindings> | undefined;
  let resolved: WorkspaceBindings | undefined;
  // The executor always loads bindings before a provider is built, so `resolved` is set by then.
  const bindings = () =>
    (loaded ??= loadWorkspaceBindings(auth.db, auth.workspaceId).then((b) => (resolved = b)));
  return {
    registry: toolRegistry,
    providers: providerFactory(auth, () => resolved),
    log: new SupabaseActionLog(auth.db),
    bindings,
    loadBindings: async () => (await bindings()).bindings,
    permissionFor: async (binding: CapabilityBinding) =>
      (await bindings()).permissions.get(`${binding.connectionId}:${binding.capability}`) ??
      "understand",
  };
}

/**
 * A tool call made by the user in the UI. Goes through exactly the same path as Chat
 * (validation, provider resolution, policy, audit) with origin `user_ui`.
 */
export async function runUserTool(
  auth: AuthContext,
  name: string,
  args: unknown,
  idempotencyKey?: string,
) {
  const outcome = await executeToolCall(createExecutorPorts(auth), toolContext(auth, "user_ui"), {
    name,
    args,
    idempotencyKey: idempotencyKey ? `ui:${idempotencyKey}` : null,
  });
  if (outcome.status === "failed") {
    throw new AppError(outcome.error.code, outcome.error.message, {
      recovery: outcome.error.recovery,
    });
  }
  if (outcome.status !== "succeeded") {
    throw new AppError("PERMISSION_DENIED", "This action needs attention before it can run", {
      recovery: "review",
    });
  }
  return outcome;
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

/** Account names the model may use as `destination` (no ids, no credentials). */
export function accountSummaries(bindings: readonly CapabilityBinding[]): AccountSummary[] {
  return bindings
    .filter((b) => b.enabled && b.connectionStatus === "connected")
    .map((b) => ({
      capability: b.capability,
      label: b.label,
      provider: b.providerKey,
      account: b.accountLabel,
      context: b.contextLabel,
      isDefault: b.isDefault,
    }));
}

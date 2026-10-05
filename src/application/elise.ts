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
import type { ThreadRef } from "@/core/interaction";
import type { KnowledgeManager } from "@/core/knowledge/admin";
import type { CapabilityBinding } from "@/core/providers/types";
import { CALENDAR_TOOLS } from "@/core/tools/calendar";
import { CONTEXT_TOOLS } from "@/core/tools/contexts";
import { EMAIL_TOOLS } from "@/core/tools/email";
import { FINANCE_TOOLS } from "@/core/tools/finance";
import { GOAL_TOOLS } from "@/core/tools/goals";
import { HABIT_TOOLS } from "@/core/tools/habits";
import { HISTORY_TOOLS } from "@/core/tools/history";
import { KNOWLEDGE_TOOLS } from "@/core/tools/knowledge";
import { KNOWLEDGE_ADMIN_TOOLS } from "@/core/tools/knowledge-admin";
import { LIST_TOOLS } from "@/core/tools/lists";
import { LOCATION_TOOLS } from "@/core/tools/location";
import { MEETING_TOOLS } from "@/core/tools/meeting";
import { METHOD_TOOLS } from "@/core/tools/methods";
import { NOTE_TOOLS } from "@/core/tools/notes";
import { PLANNING_TOOLS } from "@/core/tools/planning";
import { SCHEDULE_TOOLS } from "@/core/tools/schedules";
import { SETTINGS_TOOLS } from "@/core/tools/settings";
import { SHORTCUT_TOOLS } from "@/core/tools/shortcuts";
import { STRUCTURED_TOOLS } from "@/core/tools/structured";
import { STUDY_TOOLS } from "@/core/tools/study";
import { TASK_TOOLS } from "@/core/tools/tasks";
import { WEATHER_TOOLS } from "@/core/tools/weather";
import { WEB_TOOLS } from "@/core/tools/web";
import { WORKSPACE_TOOLS } from "@/core/tools/workspace";
import { getAIProvider, getEmbeddingProvider } from "@/infrastructure/ai";
import { logger } from "@/infrastructure/observability/logger";
import { EliseFinanceProvider } from "@/infrastructure/providers/elise-native/finance";
import { EliseGoalsProvider } from "@/infrastructure/providers/elise-native/goals";
import { EliseHabitsProvider } from "@/infrastructure/providers/elise-native/habits";
import { EliseListsProvider } from "@/infrastructure/providers/elise-native/lists";
import { EliseNotesProvider } from "@/infrastructure/providers/elise-native/notes";
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
import { GoogleSheetsFinanceProvider } from "@/infrastructure/providers/google/sheets-finance";
import { GoogleTasksProvider } from "@/infrastructure/providers/google/tasks";
import { NotionClient } from "@/infrastructure/providers/notion/client";
import { NotionHttp } from "@/infrastructure/providers/notion/http";
import { NotionStructuredApi } from "@/infrastructure/providers/notion/structured";
import { NotionStructuredProvider } from "@/infrastructure/providers/notion/structured-provider";
import { createAdminClient } from "@/infrastructure/supabase/admin";
import { SupabaseActionLog } from "@/infrastructure/supabase/repositories/action-log";
import {
  loadWorkspaceBindings,
  type WorkspaceBindings,
} from "@/infrastructure/supabase/repositories/bindings";
import { SupabaseKnowledgeReader } from "@/infrastructure/supabase/repositories/knowledge";
import { SupabaseRecallReader } from "@/infrastructure/supabase/repositories/recall";

import type { AuthContext } from "./auth-context";
import { contextStore } from "./contexts-service";
import { knowledgeManager } from "./knowledge-admin";
import { locationCapability } from "./location-service";
import { methodStore } from "./methods-service";
import { syncNoteToKnowledge } from "./notes-knowledge";
import { catchUpRecall } from "./recall-service";
import { settingsStore } from "./settings-service";
import { shortcutStore } from "./shortcuts-service";
import { startStructuredBulk } from "./structured-bulk";
import { studyStore } from "./study-service";
import { weatherCapability } from "./weather-service";
import { webCapability } from "./web-service";

/** Every tool ELISE can use. Exposure per run is filtered by available capabilities. */
export const toolRegistry = new ToolRegistry().register(
  ...TASK_TOOLS,
  ...CALENDAR_TOOLS,
  ...EMAIL_TOOLS,
  ...SCHEDULE_TOOLS,
  ...KNOWLEDGE_TOOLS,
  ...KNOWLEDGE_ADMIN_TOOLS,
  ...HABIT_TOOLS,
  ...GOAL_TOOLS,
  ...LIST_TOOLS,
  ...NOTE_TOOLS,
  ...FINANCE_TOOLS,
  ...STRUCTURED_TOOLS,
  ...HISTORY_TOOLS,
  ...SETTINGS_TOOLS,
  ...WORKSPACE_TOOLS,
  ...MEETING_TOOLS,
  ...WEB_TOOLS,
  ...LOCATION_TOOLS,
  ...WEATHER_TOOLS,
  ...CONTEXT_TOOLS,
  ...STUDY_TOOLS,
  ...PLANNING_TOOLS,
  ...SHORTCUT_TOOLS,
  ...METHOD_TOOLS,
);

/**
 * A revoked/expired grant: stop using the connection for resolution (status), tell the user
 * once, and keep an audit trail. Never falls back to another account.
 */
async function markNeedsReauthorization(
  auth: AuthContext,
  ref: ConnectionRef,
  code: string,
  providerName: string,
) {
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
      title: `${providerName} “${data.display_name}” needs to be reconnected`,
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
      provider_key: providerName.toLowerCase(),
      connection_id: ref.connectionId,
      origin: "system",
      result: "failure",
      metadata: { code },
    }),
  ]);
}

/** Authenticated Google client for one connection of this workspace (tokens stay server-side). */
export function googleHttpFor(auth: AuthContext, connectionId: string): GoogleHttp {
  const ref = { connectionId, workspaceId: auth.workspaceId };
  return new GoogleHttp(
    new GoogleTokenProvider(ref, {
      vault: new SupabaseCredentialVault(createAdminClient(), "google"),
      config: googleOAuthConfig(),
      onReauthorizationRequired: (r, code) => markNeedsReauthorization(auth, r, code, "Google"),
    }),
  );
}

/** Token + revocation handling for one Notion connection (shared by Knowledge and Structured). */
function notionAuth(auth: AuthContext, connectionId: string) {
  const ref = { connectionId, workspaceId: auth.workspaceId };
  const vault = new SupabaseCredentialVault(createAdminClient(), "notion");
  return {
    token: async () => {
      const credential = await vault.read(ref);
      if (!credential) {
        await markNeedsReauthorization(auth, ref, "missing_credentials", "Notion");
        throw new AppError("AUTH_EXPIRED", "This Notion connection needs to be reconnected", {
          recovery: "reconnect",
        });
      }
      return credential.accessToken;
    },
    onUnauthorized: () => markNeedsReauthorization(auth, ref, "unauthorized", "Notion"),
  };
}

/** Notion client for Knowledge (one connection of this workspace). Notion tokens do not expire. */
export function notionClientFor(auth: AuthContext, connectionId: string): NotionClient {
  const a = notionAuth(auth, connectionId);
  return new NotionClient(a.token, a.onUnauthorized);
}

/** Notion structured-data API for one connection of this workspace. */
export function notionStructuredApiFor(auth: AuthContext, connectionId: string) {
  const a = notionAuth(auth, connectionId);
  return new NotionStructuredApi(new NotionHttp(a.token, a.onUnauthorized));
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
      http = googleHttpFor(auth, connectionId);
      google.set(connectionId, http);
    }
    return http;
  };
  let knowledge: (SupabaseKnowledgeReader & KnowledgeManager) | undefined;

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
    habits(binding) {
      if (binding.providerKey !== "elise_native") throw unsupported("habits", binding);
      return new EliseHabitsProvider(auth.db, auth.workspaceId, auth.userId);
    },
    goals(binding) {
      if (binding.providerKey !== "elise_native") throw unsupported("goals", binding);
      return new EliseGoalsProvider(auth.db, auth.workspaceId, auth.userId);
    },
    lists(binding) {
      if (binding.providerKey !== "elise_native") throw unsupported("lists", binding);
      return new EliseListsProvider(auth.db, auth.workspaceId, auth.userId);
    },
    notes(binding) {
      if (binding.providerKey !== "elise_native") throw unsupported("notes", binding);
      // Every change to a note keeps its Knowledge representation in step.
      return new EliseNotesProvider(auth.db, auth.workspaceId, auth.userId, (note, archived) =>
        syncNoteToKnowledge(auth.workspaceId, note, archived).catch((error) =>
          logger.warn("knowledge.note_sync_failed", {
            note_id: note.id,
            code: error instanceof AppError ? error.code : "UNKNOWN",
          }),
        ),
      );
    },
    finance(binding) {
      if (binding.providerKey === "elise_native") {
        return new EliseFinanceProvider(
          auth.db,
          auth.workspaceId,
          auth.userId,
          binding.connectionId,
          auth.profile.locale,
        );
      }
      // Connected Google Sheets: read-only, from the rows the last sync mirrored.
      if (binding.providerKey === "google") {
        return new GoogleSheetsFinanceProvider(auth.db, auth.workspaceId, binding.connectionId);
      }
      throw unsupported("finance", binding);
    },
    structured(binding) {
      if (binding.providerKey !== "notion") throw unsupported("structured", binding);
      return new NotionStructuredProvider(
        auth.db,
        auth.workspaceId,
        binding.connectionId,
        binding.label,
        notionStructuredApiFor(auth, binding.connectionId),
        (input) => startStructuredBulk(auth.workspaceId, auth.userId, input),
      );
    },
    // ELISE's own index, whatever the source; always this workspace's.
    knowledge() {
      knowledge ??= Object.assign(
        new SupabaseKnowledgeReader(auth.db, auth.workspaceId, getEmbeddingProvider),
        knowledgeManager(auth),
      );
      return knowledge;
    },
    // Recall is always the user's own interactions (RLS: author-only).
    history() {
      return new SupabaseRecallReader(
        auth.db,
        auth.workspaceId,
        auth.userId,
        getEmbeddingProvider,
        // Recall never depends on the background worker: unindexed turns are indexed first.
        (skip) => catchUpRecall(auth.workspaceId, auth.userId, skip),
      );
    },
    settings() {
      return settingsStore(auth);
    },
    // The public web: server-provided, per-workspace limits (ADR-015).
    web_search() {
      return webCapability(auth);
    },
    // Places and travel: server-provided, no user connection (ADR-023).
    location() {
      return locationCapability(auth);
    },
    // Forecasts: server-provided, no user connection (ADR-038).
    weather() {
      return weatherCapability(auth);
    },
    // Context Profiles (ADR-016): this workspace's organizational layer, through RLS. Task
    // lists come from every connected provider, read through the executor like any read.
    contexts() {
      return contextStore(auth, async () => {
        const outcome = await executeToolCall(
          createExecutorPorts(auth),
          toolContext(auth, "user_ui"),
          { name: "tasks.listLists", args: {} },
        );
        return outcome.status === "succeeded" && outcome.display?.kind === "task_lists"
          ? outcome.display.lists.map((l) => ({
              id: l.id,
              name: l.name,
              source: l.provenance.source,
            }))
          : [];
      });
    },
    // Study: the user's own sessions and progress, plus AI for questions and evaluation.
    study() {
      let ai: ReturnType<typeof getAIProvider> | null = null;
      try {
        ai = getAIProvider();
      } catch {
        ai = null;
      }
      return { store: studyStore(auth), ai };
    },
    shortcuts() {
      return shortcutStore(auth);
    },
    // The workspace's Methods (ADR-040): instructions only, never authority.
    methods() {
      return methodStore(auth);
    },
    // The Morning Brief service builds on this module; loaded lazily to keep imports acyclic.
    briefs() {
      return {
        today: async () => (await import("./morning-brief-service")).briefNow(auth),
      };
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
  thread: ThreadRef | null = null,
): ToolContext {
  return {
    workspaceId: auth.workspaceId,
    userId: auth.userId,
    timezone: auth.profile.timezone,
    locale: auth.profile.locale,
    now: new Date(),
    origin,
    aiRunId,
    ...(thread?.kind === "conversation" ? { conversationId: thread.id } : {}),
    ...(thread?.kind === "session" ? { interactionSessionId: thread.id } : {}),
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

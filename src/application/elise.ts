import "server-only";

import { serverEnv } from "@/config/server-env";
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
import type { TaskProvider } from "@/core/capabilities/tasks";
import type { CapabilityKey } from "@/core/capabilities/types";
import { AppError } from "@/core/errors";
import type { ThreadRef } from "@/core/interaction";
import type { KnowledgeManager } from "@/core/knowledge/admin";
import type { CapabilityBinding } from "@/core/providers/types";
import { ALARM_TOOLS } from "@/core/tools/alarms";
import { CALENDAR_TOOLS } from "@/core/tools/calendar";
import { CONTEXT_TOOLS } from "@/core/tools/contexts";
import { ECONOMY_TOOLS } from "@/core/tools/economy";
import { EMAIL_TOOLS } from "@/core/tools/email";
import { FINANCE_TOOLS } from "@/core/tools/finance";
import { GOAL_TOOLS } from "@/core/tools/goals";
import { HABIT_TOOLS } from "@/core/tools/habits";
import { HISTORY_TOOLS } from "@/core/tools/history";
import { HOME_TOOLS } from "@/core/tools/home";
import { KNOWLEDGE_TOOLS } from "@/core/tools/knowledge";
import { KNOWLEDGE_ADMIN_TOOLS } from "@/core/tools/knowledge-admin";
import { LIST_TOOLS } from "@/core/tools/lists";
import { LOCATION_TOOLS } from "@/core/tools/location";
import { MARKETPLACE_TOOLS } from "@/core/tools/marketplace";
import { MARKET_TOOLS } from "@/core/tools/markets";
import { MEETING_TOOLS } from "@/core/tools/meeting";
import { METHOD_TOOLS } from "@/core/tools/methods";
import { MUSIC_TOOLS } from "@/core/tools/music";
import { NOTE_TOOLS } from "@/core/tools/notes";
import { PLANNING_TOOLS } from "@/core/tools/planning";
import { SCHEDULE_TOOLS } from "@/core/tools/schedules";
import { SETTINGS_TOOLS } from "@/core/tools/settings";
import { SHOPPING_TOOLS } from "@/core/tools/shopping";
import { SHORTCUT_TOOLS } from "@/core/tools/shortcuts";
import { STRUCTURED_TOOLS } from "@/core/tools/structured";
import { STUDY_TOOLS } from "@/core/tools/study";
import { TASK_TOOLS } from "@/core/tools/tasks";
import { TEAM_MESSAGING_TOOLS } from "@/core/tools/team-messaging";
import { TIME_TOOLS } from "@/core/tools/time";
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
import { getMicrosoftOAuthConfig } from "@/infrastructure/providers/microsoft/config";
import { GraphHttp } from "@/infrastructure/providers/microsoft/http";
import {
  IDENTITY_SCOPES as MICROSOFT_IDENTITY_SCOPES,
  refreshAccessToken as refreshMicrosoftToken,
} from "@/infrastructure/providers/microsoft/oauth";
import { OutlookProvider } from "@/infrastructure/providers/microsoft/outlook";
import { NotionClient } from "@/infrastructure/providers/notion/client";
import { NotionHttp } from "@/infrastructure/providers/notion/http";
import { NotionStructuredApi } from "@/infrastructure/providers/notion/structured";
import { NotionStructuredProvider } from "@/infrastructure/providers/notion/structured-provider";
import { getSlackOAuthConfig, slackSetup } from "@/infrastructure/providers/slack/config";
import { SlackHttp } from "@/infrastructure/providers/slack/http";
import { refreshAccessToken as refreshSlackToken } from "@/infrastructure/providers/slack/oauth";
import { SlackProvider } from "@/infrastructure/providers/slack/team-messaging";
import {
  SpotifyMusicProvider,
  SpotifyTokenProvider,
} from "@/infrastructure/providers/spotify/music";
import { spotifyOAuthConfig } from "@/infrastructure/providers/spotify/oauth";
import {
  EnrichedTaskProvider,
  TaskEnrichmentStore,
} from "@/infrastructure/providers/task-enrichment";
import { TaskRecurrenceStore } from "@/infrastructure/providers/task-recurrence";
import { YouTubeMusicProvider } from "@/infrastructure/providers/youtube/music";
import { createAdminClient } from "@/infrastructure/supabase/admin";
import { SupabaseActionLog } from "@/infrastructure/supabase/repositories/action-log";
import {
  loadWorkspaceBindings,
  type WorkspaceBindings,
} from "@/infrastructure/supabase/repositories/bindings";
import { SupabaseKnowledgeReader } from "@/infrastructure/supabase/repositories/knowledge";
import { SupabaseRecallReader } from "@/infrastructure/supabase/repositories/recall";

import { alarmStore } from "./alarm-service";
import type { AuthContext } from "./auth-context";
import { contextStore } from "./contexts-service";
import { economyCapability } from "./economy-service";
import { homeStore } from "./home-service";
import { knowledgeManager } from "./knowledge-admin";
import { liveKnowledge } from "./knowledge-live";
import { locationCapability } from "./location-service";
import { marketsCapability, readWatchlist, writeWatchlist } from "./markets-service";
import { methodStore } from "./methods-service";
import { syncNoteToKnowledge } from "./notes-knowledge";
import { catchUpRecall } from "./recall-service";
import { settingsStore } from "./settings-service";
import { shoppingCapability } from "./shopping-service";
import { shortcutStore } from "./shortcuts-service";
import { startStructuredBulk } from "./structured-bulk";
import { studyStore } from "./study-service";
import { timerStore } from "./time-service";
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
  ...MARKET_TOOLS,
  ...ECONOMY_TOOLS,
  ...SHOPPING_TOOLS,
  ...MARKETPLACE_TOOLS,
  ...HOME_TOOLS,
  ...CONTEXT_TOOLS,
  ...STUDY_TOOLS,
  ...PLANNING_TOOLS,
  ...SHORTCUT_TOOLS,
  ...METHOD_TOOLS,
  ...MUSIC_TOOLS,
  ...TIME_TOOLS,
  ...ALARM_TOOLS,
  ...TEAM_MESSAGING_TOOLS,
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
      title: `${providerName} â€œ${data.display_name}â€ needs to be reconnected`,
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

/**
 * Microsoft Graph client for one connection of this workspace (tokens stay server-side). The
 * refresh asks again for the scopes this account was granted, so it keeps exactly those.
 */
export function microsoftHttpFor(auth: AuthContext, connectionId: string): GraphHttp {
  const ref = { connectionId, workspaceId: auth.workspaceId };
  const vault = new SupabaseCredentialVault(createAdminClient(), "microsoft");
  const config = getMicrosoftOAuthConfig();
  const reauthorize = (r: ConnectionRef, code: string) =>
    markNeedsReauthorization(auth, r, code, "Microsoft");
  return new GraphHttp(
    new GoogleTokenProvider(ref, {
      vault,
      providerName: "Microsoft",
      onReauthorizationRequired: reauthorize,
      refresh: async (refreshToken) => {
        const granted = (await vault.read(ref))?.scopes ?? [];
        const scopes = [...new Set([...MICROSOFT_IDENTITY_SCOPES, ...granted])];
        return refreshMicrosoftToken(config, refreshToken, scopes);
      },
    }),
    { onUnauthorized: (reason) => reauthorize(ref, reason) },
  );
}

/**
 * Slack (Team Messaging, ADR-062) for one connection of this workspace, with the user's own token.
 * Tokens stay server-side. With token rotation on, refreshes are serialized by a lease (Slack's
 * refresh tokens work once). Without client settings on this server or worker, it is a setup
 * problem (SERVER_NOT_CONFIGURED), never "Slack isn't connected".
 */
export function slackProviderFor(auth: AuthContext, binding: CapabilityBinding): SlackProvider {
  const config = getSlackOAuthConfig();
  const ref = { connectionId: binding.connectionId, workspaceId: auth.workspaceId };
  const vault = new SupabaseCredentialVault(createAdminClient(), "slack");
  const reauthorize = (r: ConnectionRef, code: string) =>
    markNeedsReauthorization(auth, r, code, "Slack");
  const tokens = new GoogleTokenProvider(ref, {
    vault,
    providerName: "Slack",
    onReauthorizationRequired: reauthorize,
    refresh: (refreshToken) => refreshSlackToken(config, refreshToken),
    lease: {
      acquire: (r) => vault.acquireRefreshLease(r),
      release: (r) => vault.releaseRefreshLease(r),
    },
  });
  const http = new SlackHttp(tokens, {
    onUnauthorized: (reason) => reauthorize(ref, reason),
    // Which call, how many tries, how long, whether Slack throttled: never arguments or content.
    log: (e) =>
      logger[e.ok ? "info" : "warn"]("slack.api", {
        method: e.method,
        connection_id: binding.connectionId,
        attempts: e.attempts,
        latency_ms: e.latencyMs,
        rate_limited: e.rateLimited,
        ...(e.error ? { error: e.error } : {}),
      }),
  });
  return new SlackProvider(
    { connectionId: binding.connectionId, label: binding.label, unlisted: slackSetup().unlisted },
    http,
    async () => (await vault.read(ref))?.scopes ?? [],
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
  const microsoft = new Map<string, GraphHttp>();
  const googleHttp = (connectionId: string) => {
    let http = google.get(connectionId);
    if (!http) {
      http = googleHttpFor(auth, connectionId);
      google.set(connectionId, http);
    }
    return http;
  };
  let taskEnrichment: TaskEnrichmentStore | undefined;
  let taskSeries: TaskRecurrenceStore | undefined;
  let knowledge:
    (SupabaseKnowledgeReader & KnowledgeManager & ReturnType<typeof liveKnowledge>) | undefined;

  const make: {
    [K in ImplementedCapability]: (binding: CapabilityBinding) => CapabilityProviders[K];
  } = {
    tasks(binding) {
      // ELISE's labels and priority ride on top of every provider (ADR-050), never copied in.
      const enrich = (inner: TaskProvider) =>
        new EnrichedTaskProvider(
          inner,
          (taskEnrichment ??= new TaskEnrichmentStore(auth.db, auth.workspaceId)),
          binding.providerKey,
          binding.connectionId,
          (taskSeries ??= new TaskRecurrenceStore(
            auth.db,
            auth.workspaceId,
            auth.userId,
            auth.profile.timezone,
            auth.profile.locale,
          )),
        );
      if (binding.providerKey === "elise_native") {
        return enrich(new EliseTasksProvider(auth.db, auth.workspaceId, binding.connectionId));
      }
      if (binding.providerKey === "google") {
        return enrich(
          new GoogleTasksProvider(
            { connectionId: binding.connectionId, label: binding.label },
            googleHttp(binding.connectionId),
          ),
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
      const conn = {
        connectionId: binding.connectionId,
        label: binding.label,
        account: binding.accountLabel,
      };
      if (binding.providerKey === "microsoft") {
        // One Graph client per connection and run: it holds the mailbox's concurrency limit.
        let http = microsoft.get(binding.connectionId);
        if (!http)
          microsoft.set(
            binding.connectionId,
            (http = microsoftHttpFor(auth, binding.connectionId)),
          );
        return new OutlookProvider(conn, http);
      }
      if (binding.providerKey !== "google") throw unsupported("email", binding);
      return new GmailProvider(conn, googleHttp(binding.connectionId));
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
      return new EliseNotesProvider(
        auth.db,
        auth.workspaceId,
        auth.userId,
        (note, archived, textChanged) =>
          syncNoteToKnowledge(auth.workspaceId, note, archived, textChanged).catch((error) =>
            logger.warn("knowledge.note_sync_failed", {
              note_id: note.id,
              code: error instanceof AppError ? error.code : "UNKNOWN",
            }),
          ),
      );
    },
    finance(binding) {
      if (binding.providerKey === "elise_native") {
        const native = new EliseFinanceProvider(
          auth.db,
          auth.workspaceId,
          auth.userId,
          binding.connectionId,
          auth.profile.locale,
        );
        // Chat imports run the Finance screen's own pipeline (ADR-075).
        return Object.assign(native, {
          // Lazy: finance-import reads Google helpers from this module.
          analyzeImportFile: async (attachmentId: string) =>
            (await import("./finance-import")).analyzeAttachmentImport(auth, attachmentId),
        });
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
        // Drive and Notion are asked live, never read from a copy (ADR-046).
        liveKnowledge(auth),
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
    // Public market data: server-provided, no user connection (ADR-074).
    // ELISE Home: the person's own devices, through their paired hub (ADR-079).
    home() {
      return homeStore(auth);
    },
    markets() {
      return {
        ...marketsCapability(),
        watchlist: { list: () => readWatchlist(auth), save: (l) => writeWatchlist(auth, l) },
      };
    },
    weather() {
      return weatherCapability(auth);
    },
    // Public economic data: server-provided, shared across workspaces (ADR-094).
    economy() {
      return economyCapability();
    },
    // Public supermarket prices plus the person's links and alerts, under RLS (ADR-111).
    shopping() {
      return shoppingCapability(auth);
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
    // Music (ADR-042): the user's Spotify account, or YouTube's search + embedded player.
    music(binding) {
      if (binding.providerKey === "spotify") {
        const ref = { connectionId: binding.connectionId, workspaceId: auth.workspaceId };
        return new SpotifyMusicProvider(
          new SpotifyTokenProvider(ref, {
            vault: new SupabaseCredentialVault(createAdminClient(), "spotify"),
            config: () => spotifyOAuthConfig(),
            onReauthorizationRequired: (r, code) =>
              markNeedsReauthorization(auth, r, code, "Spotify"),
          }),
        );
      }
      if (binding.providerKey === "youtube") {
        const key = serverEnv().YOUTUBE_API_KEY;
        if (!key)
          throw new AppError("SERVER_NOT_CONFIGURED", "YouTube is not configured on this server", {
            recovery: "configure",
          });
        return new YouTubeMusicProvider(key);
      }
      throw unsupported("music", binding);
    },
    team_messaging(binding) {
      if (binding.providerKey !== "slack") throw unsupported("team_messaging", binding);
      return slackProviderFor(auth, binding);
    },
    // The user's own timers (ADR-045) and alarms (ADR-100): personal, through RLS.
    time() {
      return { ...timerStore(auth), ...alarmStore(auth) };
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

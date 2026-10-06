import { listPendingApprovals } from "@/application/approvals-service";
import type { AuthContext } from "@/application/auth-context";
import { requireAuthContext } from "@/application/auth-context";
import { listConnections } from "@/application/connections-service";
import { contextOptions } from "@/application/contexts-service";
import { loadVoiceSession } from "@/application/interaction-thread";
import { listSpaces } from "@/application/knowledge-service";
import { liveVoiceEnabled } from "@/application/live-voice-service";
import { latestBrief } from "@/application/schedules-service";
import { shortcutStore } from "@/application/shortcuts-service";
import { openTasks } from "@/application/tasks-service";
import { activeWorkspace, loadWorkspace } from "@/application/workspace-service";
import { isEnabled } from "@/config/flags";
import { ChatSurface } from "@/features/chat/chat-surface";
import { firstPromptKeys, type SpacePreset } from "@/features/onboarding/model";
import { getT } from "@/lib/i18n/server";

/** Home is chat-first: the Orb, one input, and only real, quiet context. */
export default async function HomePage({ searchParams }: PageProps<"/">) {
  const [auth, params] = await Promise.all([requireAuthContext(), searchParams]);
  const spaceId = typeof params.space === "string" ? params.space : null;
  // A voice session reopens here (it has no History thread of its own).
  const sessionId =
    typeof params.session === "string" && /^[0-9a-f-]{36}$/i.test(params.session)
      ? params.session
      : null;
  const voiceSession = sessionId
    ? await Promise.all([
        loadVoiceSession(auth, sessionId),
        loadWorkspace(auth, { kind: "session", id: sessionId }).catch(() => undefined),
      ])
    : null;
  // "Nueva conversación" arrives as ?new=…; ?gone=… means the tab's active one is no longer there.
  const fresh = typeof params.new === "string";
  const gone =
    typeof params.gone === "string" && /^[0-9a-f-]{36}$/i.test(params.gone)
      ? params.gone
      : sessionId && !voiceSession?.[0]
        ? sessionId
        : null;
  const restored = voiceSession?.[0]
    ? { messages: voiceSession[0], workspace: voiceSession[1] }
    : null;
  // "Run" from My Elise sends the Shortcut's own phrase — never text taken from the URL.
  const runId =
    typeof params.run === "string" && /^[0-9a-f-]{36}$/i.test(params.run) ? params.run : null;
  const run = runId
    ? ((
        await shortcutStore(auth)
          .list()
          .catch(() => [])
      ).find((s) => s.id === runId && s.enabled)?.phrases[0] ?? null)
    : null;
  const [tasks, approvals, brief, resume, contexts] = await Promise.all([
    // Same service and definitions as the Tasks screen, so the counts match what it lists.
    openTasks(auth).catch(() => null) /* ambient context never blocks Home */,
    // Ambient context never blocks Home: any source failing just hides its line.
    listPendingApprovals(auth).catch(() => []),
    latestBrief(auth).catch(() => null),
    // Right after "Nueva conversación", offering to continue the one just left would undo it.
    fresh ? null : activeWorkspace(auth).catch(() => null),
    contextOptions(auth).catch(() => []),
  ]);
  // Right after onboarding: a first prompt built from what was set up (never text from the URL).
  const firstPrompts = params.welcome === "1" ? await firstRunPrompts(auth) : null;
  // Only a Space of this workspace can scope the conversation.
  const space = spaceId
    ? ((await listSpaces(auth).catch(() => [])).find((s) => s.id === spaceId) ?? null)
    : null;

  return (
    <ChatSurface
      key={restored ? sessionId : fresh ? `new:${String(params.new)}` : "home"}
      gone={gone}
      fresh={fresh}
      {...(restored
        ? {
            thread: { kind: "session" as const, id: sessionId! },
            initialMessages: restored.messages,
            initialWorkspace: restored.workspace,
          }
        : {})}
      voice={{
        ...auth.profile.voice,
        wakeEnabled: auth.profile.voice.wakeEnabled && isEnabled("wakePhrase", auth),
        runtime: liveVoiceEnabled() ? "live" : "legacy",
      }}
      timezone={auth.profile.timezone}
      workspaceId={auth.workspaceId}
      userName={auth.profile.displayName ?? ""}
      contexts={contexts}
      run={run}
      firstPrompts={firstPrompts}
      space={
        space ? { id: space.id, path: space.path, icon: space.icon, color: space.color } : null
      }
      ambient={{
        dueToday: tasks?.counts.dueToday ?? 0,
        overdue: tasks?.counts.overdue ?? 0,
        pendingApprovals: approvals.length,
        brief,
        resume,
      }}
    />
  );
}

async function firstRunPrompts(auth: AuthContext): Promise<string[]> {
  const [{ t }, connections, spaces, progress] = await Promise.all([
    getT(),
    listConnections(auth).catch(() => null),
    listSpaces(auth).catch(() => []),
    auth.db
      .from("user_preferences")
      .select("value_json")
      .eq("workspace_id", auth.workspaceId)
      .eq("user_id", auth.userId)
      .eq("key", "onboarding.progress")
      .maybeSingle(),
  ]);
  const on = (key: string) =>
    (connections?.connections ?? []).some(
      (c) =>
        c.providerKey === "google" &&
        c.health === "connected" &&
        c.capabilities.some((x) => x.key === key && x.enabled && x.granted),
    );
  // The user's own Spaces (General Knowledge is always there, ADR-047).
  const top = spaces.filter((s) => !s.parentId && !s.general);
  const preset = (progress.data?.value_json as { spacePreset?: SpacePreset } | null)?.spacePreset;
  return firstPromptKeys({
    calendar: on("calendar"),
    email: on("email"),
    tasks: true,
    spacePreset: preset ?? null,
    spaceName: top[0]?.name ?? null,
  }).map((key) => t.onboarding.firstPrompts[key]);
}

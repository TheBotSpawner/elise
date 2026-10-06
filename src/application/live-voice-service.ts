import "server-only";

import { createHash } from "node:crypto";

import { serverEnv } from "@/config/server-env";
import type { ClientPlayback } from "@/core/capabilities/music";
import { AppError } from "@/core/errors";
import {
  isCancellation,
  liveInstructions,
  resultContent,
  type DelegationResult,
} from "@/core/voice/live";
import { createLiveWebRtcSession } from "@/infrastructure/ai";
import { logger } from "@/infrastructure/observability/logger";
import { recordUsage } from "@/infrastructure/observability/usage";
import { rateLimit } from "@/infrastructure/rate-limit";
import { createAdminClient } from "@/infrastructure/supabase/admin";

import type { AuthContext } from "./auth-context";
import type { ChatStreamEvent } from "./chat-protocol";
import { prepareTurn, type TurnEventSink } from "./chat-service";
import { openThread } from "./interaction-thread";
import { queueRecallIndex } from "./recall-service";

/**
 * GPT-Live voice (ADR-026): session setup and the delegation adapter of ELISE's turn engine.
 * Audio never passes through ELISE: the browser talks to GPT-Live over WebRTC. ELISE only
 * creates the session (with its key, server-side) and answers delegations through the same
 * engine, tools, policies and approvals as typed chat.
 */

export function liveVoiceEnabled(): boolean {
  const env = serverEnv();
  return env.VOICE_RUNTIME !== "legacy" && Boolean(env.OPENAI_API_KEY);
}

/** Stable, privacy-preserving end-user id for OpenAI's abuse detection (no email or name). */
const safetyId = (userId: string) =>
  createHash("sha256").update(`elise:${userId}`).digest("hex").slice(0, 32);

export async function createLiveSession(auth: AuthContext, sdp: string) {
  if (!auth.profile.voice.enabled)
    throw new AppError("PERMISSION_DENIED", "Voice is turned off in Settings", {
      recovery: "review",
    });
  if (!liveVoiceEnabled())
    throw new AppError("CAPABILITY_UNAVAILABLE", "Live voice isn't enabled", {
      recovery: "configure",
    });
  rateLimit(`voice.live:${auth.userId}`, 12, 60_000, "Too many voice sessions. Wait a moment.");
  const env = serverEnv();
  const started = Date.now();
  const session = await createLiveWebRtcSession({
    apiKey: env.OPENAI_API_KEY!,
    sdp,
    instructions: liveInstructions({
      locale: auth.profile.locale,
      displayName: auth.profile.displayName,
    }),
    voice: auth.profile.voice.voice,
    safetyIdentifier: safetyId(auth.userId),
  });
  logger.info("voice.live_session_created", {
    workspace_id: auth.workspaceId,
    latency_ms: Date.now() - started,
  });
  return session;
}

/** A delegation's request, as the browser reconstructed it from the live transcript. */
export interface DelegationRequest {
  delegationId: string;
  /** The interaction this Live session continues: a conversation, a voice session, or none yet. */
  conversationId: string | null;
  sessionId: string | null;
  text: string;
  /** Draft attachments that belong to this spoken turn (ADR-031). */
  attachments?: string[];
  /** The user's position, when they share it (ADR-023/028); coarse, never stored. */
  here?: { lat: number; lng: number };
  /** The page's embedded music player state (ADR-042). */
  music?: ClientPlayback;
  requestId: string;
  receivedAt: number;
}

const delegationRequest = (id: string) => `live:${id}`;

/**
 * Runs one delegation through the turn engine and emits its events (Canvas, activity, text)
 * followed by the compact result GPT-Live speaks from. A delegation runs once; a cancellation
 * never runs the model.
 */
export async function runDelegation(
  auth: AuthContext,
  req: DelegationRequest,
  emit: TurnEventSink,
  signal?: AbortSignal,
): Promise<void> {
  const locale = auth.profile.locale;
  const finish = (result: DelegationResult) =>
    emit({
      type: "delegation",
      delegationId: req.delegationId,
      result,
      content: resultContent(result, locale),
    });

  if (isCancellation(req.text)) {
    // The browser aborted the work in flight; what already happened stays reported by it.
    finish({
      status: "cancelled",
      spoken: locale === "es" ? "Listo, lo dejo." : "Okay, I'll leave it.",
      facts: [],
    });
    return;
  }
  const { data: dup } = await auth.db
    .from("ai_runs")
    .select("id")
    .eq("request_id", delegationRequest(req.delegationId))
    .eq("user_id", auth.userId)
    .limit(1);
  if (dup?.length) throw new AppError("CONFLICT", "This delegation already ran");

  const turn = await prepareTurn(auth, {
    message: req.text,
    modality: "voice",
    ...(req.attachments?.length ? { attachments: req.attachments } : {}),
    ...(req.here ? { here: req.here } : {}),
    ...(req.music ? { music: req.music } : {}),
    ...(req.conversationId ? { conversationId: req.conversationId } : {}),
    ...(req.sessionId && !req.conversationId ? { sessionId: req.sessionId } : {}),
    requestId: delegationRequest(req.delegationId),
    receivedAt: req.receivedAt,
    live: { delegationId: req.delegationId },
    voice: { durationMs: 0, language: locale },
  });

  let spoken = "";
  let display = "";
  let failure: ChatStreamEvent | null = null;
  let approval: { summary: string } | null = null;
  await turn.run(
    (event) => {
      if (event.type === "spoken") spoken += event.delta;
      if (event.type === "text") display += event.delta;
      if (event.type === "error") failure = event;
      if (event.type === "tool_finished" && event.outcome.status === "approval_required")
        approval = { summary: event.outcome.summary };
      emit(event);
    },
    signal ? { signal } : {},
  );
  const said = (spoken || display).trim();
  const facts = spoken && display.trim() ? [clip(display.trim(), 500)] : [];
  if (signal?.aborted) {
    finish({
      status: "cancelled",
      spoken:
        locale === "es"
          ? "Lo dejé. Lo que ya se hizo antes de cancelar sigue en pantalla."
          : "Stopped. Anything already done before cancelling is on screen.",
      facts,
    });
    return;
  }
  if (failure && !said) {
    finish({
      status: "failed",
      spoken: (failure as { error: { message: string } }).error.message,
      facts: [],
    });
    return;
  }
  finish({
    status: approval ? "needs_approval" : "completed",
    spoken: clip(said, 700),
    facts,
    approval,
  });
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * Conversational turns GPT-Live answered on its own (greetings, "repeat that"): settled turns
 * enter the same voice session as delegated ones, so History and Recall see the whole
 * conversation. Returns the session id (created with the first turn).
 */
export async function persistLiveTurns(
  auth: AuthContext,
  input: {
    conversationId?: string | null;
    sessionId: string | null;
    turns: { role: "user" | "assistant"; text: string }[];
  },
): Promise<string> {
  const turns = input.turns.filter((t) => t.text.trim()).slice(0, 20);
  if (!turns.length && (input.conversationId ?? input.sessionId))
    return (input.conversationId ?? input.sessionId)!;
  const thread = await openThread(auth, {
    ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    ...(input.sessionId && !input.conversationId ? { sessionId: input.sessionId } : {}),
    modality: "voice",
    firstMessage: turns.find((t) => t.role === "user")?.text ?? turns[0]?.text ?? "Voz",
  });
  for (const t of turns) {
    const text = clip(t.text.trim(), 4000);
    if (t.role === "user") await thread.addUserTurn(text, "voice");
    else await thread.addAssistantTurn(text, "voice", { live: true });
  }
  await thread.touch();
  queueRecallIndex(auth.workspaceId, thread.ref);
  return thread.ref.id;
}

export interface LiveMetrics {
  liveSessionId: string;
  /** Cumulative billed session seconds (session.usage.updated). */
  usageSeconds?: number;
  connectMs?: number;
  /** Per turn: speech end → first assistant audio, ms. */
  firstAudioMs?: number[];
  /** User started talking over ELISE → ELISE's audio stopped, ms. */
  interruptStopMs?: number[];
  delegations?: number;
  closeReason?: string;
}

/** Session-level Live timings and usage (numbers only), kept with the voice session. */
export async function recordLiveMetrics(
  auth: AuthContext,
  sessionId: string | null,
  m: LiveMetrics,
) {
  logger.info("voice.live_metrics", { workspace_id: auth.workspaceId, ...m });
  if (m.usageSeconds && m.closeReason)
    recordUsage({
      operation: "speech",
      provider: "openai-live",
      model: "gpt-live-1",
      units: m.usageSeconds,
      unit: "seconds",
    });
  if (!sessionId) return;
  const db = createAdminClient();
  const { data } = await db
    .from("interaction_sessions")
    .select("metadata")
    .eq("id", sessionId)
    .eq("workspace_id", auth.workspaceId)
    .eq("user_id", auth.userId)
    .maybeSingle();
  if (!data) return;
  const meta = (data.metadata ?? {}) as Record<string, unknown>;
  const live = {
    ...((meta.live as Record<string, unknown>) ?? {}),
    ...m,
    at: new Date().toISOString(),
  };
  await db
    .from("interaction_sessions")
    .update({ metadata: { ...meta, live } as never })
    .eq("id", sessionId)
    .eq("workspace_id", auth.workspaceId);
}

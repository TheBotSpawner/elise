"use client";

import type { ThreadRef } from "@/core/interaction";
import { isCancellation, progressContent, TranscriptTimeline } from "@/core/voice/live";
import type { VoicePhase, VoiceProblem, VoiceState } from "@/core/voice/session";
import { initialVoice } from "@/core/voice/session";
import { draftAttachments } from "@/features/chat/draft-attachments";
import type { SendOptions, StreamListener } from "@/features/chat/use-elise-chat";

/**
 * GPT-Live in the browser (ADR-026). One persistent WebRTC session per Voice Mode: audio goes
 * straight between the browser and GPT-Live (never through ELISE's servers); the data channel
 * carries transcripts, delegations and ELISE's verified results. Delegated work runs through
 * the same chat path as typed turns, so the Canvas, traces, approvals and History are shared.
 */

export interface LiveDeps {
  /** ELISE's chat send (delegations use `live`); resolves when the turn has finished. */
  send(text: string, options?: SendOptions): Promise<void>;
  /** Cancels the turn in flight (a correction or "dejalo"). */
  stop(): void;
  getThread(): ThreadRef | null;
  onState(state: VoiceState): void;
  locale: "es" | "en";
}

interface Delegation {
  id: string;
  text: string;
  createdAt: number;
  startedAt: number | null;
  done: boolean;
}

const SILENT = 0.02;
const LOUD = 0.06;
/** Nobody spoke for this long: the session sleeps (GPT-Live bills every second it's open). */
const IDLE_SLEEP_MS = 120_000;
/** Wait this long after the last transcribed word before reading a delegation's request. */
const SETTLE_MS = 450;
/** A correction this soon after a delegation started replaces it ("mañana… no, el lunes"). */
const REPLACE_WITHIN_MS = 4_000;

export class LiveVoiceSession {
  private pc: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private mic: MediaStream | null = null;
  private audio: HTMLAudioElement | null = null;
  private ctx: AudioContext | null = null;
  private inLevel: AnalyserNode | null = null;
  private outLevel: AnalyserNode | null = null;
  private raf = 0;
  private timeline = new TranscriptTimeline();
  /** Session-time origin: transcript times are relative to it. */
  private startedAt = 0;
  private liveSessionId: string | null = null;
  private delegations: Delegation[] = [];
  /** Arrival of the last user transcript fragment (client clock). */
  private lastUserText = 0;
  private chain: Promise<void> = Promise.resolve();
  private active: Delegation | null = null;
  private progressSent = new Set<string>();
  private persistTimer = 0;
  private lastActivity = Date.now();
  private state: VoiceState;
  private unsubscribe: (() => void) | null = null;
  private muted = false;
  private ended = false;
  // Metrics (numbers only).
  private connectMs = 0;
  private usageSeconds = 0;
  private lastLoudMic = 0;
  private micLoudSince = 0;
  private outLoud = false;
  private outQuietSince = 0;
  private waitingFirstAudio = false;
  private interruptAt = 0;
  readonly firstAudioMs: number[] = [];
  readonly interruptStopMs: number[] = [];

  constructor(
    private readonly deps: LiveDeps,
    subscribe: (fn: StreamListener) => () => void,
    speak: boolean,
  ) {
    this.state = { ...initialVoice, speak };
    this.unsubscribe = subscribe((e) => this.onStream(e));
    this.offDraft = draftAttachments.subscribe(() => this.onDraft());
  }

  private offDraft: (() => void) | null = null;
  private draftKeys = new Set<string>();

  /** Files dropped into the draft: the voice model can't see them, so it delegates (ADR-031). */
  private onDraft() {
    const items = draftAttachments.get().items;
    const added = items.filter((a) => !this.draftKeys.has(a.key));
    this.draftKeys = new Set(items.map((a) => a.key));
    if (!added.length) return;
    const names = added.map((a) => `"${a.name}"`).join(", ");
    this.append(
      "session.thinking.append",
      null,
      this.deps.locale === "es"
        ? `La persona adjuntó ${names} a su próximo pedido. No podés verlos: cualquier pedido sobre esos archivos se lo pasás a ELISE.`
        : `The user attached ${names} to their next request. You can't see them: hand any request about those files to ELISE.`,
    );
  }

  level(): number {
    if (!this.inLevel || !this.outLevel) return -1;
    return Math.max(rms(this.inLevel), rms(this.outLevel));
  }

  private set(phase: VoicePhase, patch: Partial<VoiceState> = {}) {
    this.state = { ...this.state, phase, ...patch };
    this.deps.onState(this.state);
  }

  async start() {
    if (this.pc) return;
    this.ended = false;
    this.set("arming", { problem: null, sleep: null });
    const t0 = performance.now();
    try {
      this.mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (e) {
      const name = (e as DOMException).name;
      this.set("error", {
        problem:
          name === "NotAllowedError"
            ? "permission_denied"
            : name === "NotFoundError"
              ? "no_microphone"
              : "not_supported",
      });
      return;
    }
    const pc = new RTCPeerConnection();
    this.pc = pc;
    this.audio = new Audio();
    this.audio.autoplay = true;
    this.ctx = new AudioContext();
    pc.addEventListener("track", (event) => {
      const remote = new MediaStream([event.track]);
      this.audio!.srcObject = remote;
      void this.audio!.play().catch(() => undefined);
      this.outLevel = analyser(this.ctx!, remote);
    });
    for (const track of this.mic.getAudioTracks()) pc.addTrack(track, this.mic);
    this.inLevel = analyser(this.ctx, this.mic);
    const channel = pc.createDataChannel("oai-events");
    this.channel = channel;
    channel.addEventListener("message", ({ data }) => this.onServerEvent(JSON.parse(String(data))));
    pc.addEventListener("connectionstatechange", () => {
      if (pc.connectionState === "failed" || pc.connectionState === "disconnected")
        this.onConnectionLost();
    });
    try {
      await pc.setLocalDescription(await pc.createOffer());
      await iceGathered(pc, 3_000);
      const res = await fetch("/api/voice/live/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sdp: pc.localDescription!.sdp }),
      });
      if (!res.ok) throw new Error(`session ${res.status}`);
      const answer = (await res.json()) as { sdp: string; liveSessionId: string };
      this.liveSessionId = answer.liveSessionId;
      await pc.setRemoteDescription({ type: "answer", sdp: answer.sdp });
    } catch {
      this.teardown();
      this.set("error", { problem: "network" });
      return;
    }
    this.connectMs = Math.round(performance.now() - t0);
    this.startedAt = performance.now();
    this.lastActivity = Date.now();
    this.loop();
    this.persistTimer = window.setInterval(() => this.persistSettled(), 2_000);
  }

  // ── Server events ──────────────────────────────────────────────────────────

  private onServerEvent(event: {
    type: string;
    delta?: string;
    start_ms?: number;
    end_ms?: number;
    offset_ms?: number;
    delegation?: { id: string; target: string };
    usage?: { seconds?: number };
    reason?: string;
  }) {
    if (voiceDebug())
      ((window as unknown as { __eliseLiveEvents?: unknown[] }).__eliseLiveEvents ??= []).push({
        t: Math.round(performance.now()),
        type: event.type,
        ...(event.delta ? { delta: event.delta } : {}),
        ...(event.delegation ? { delegation: event.delegation.id } : {}),
        ...(event.reason ? { reason: event.reason } : {}),
      });
    switch (event.type) {
      case "session.started":
        this.set("listening");
        break;
      case "session.input_transcript.delta":
        this.timeline.add("user", event.delta ?? "", performance.now());
        this.lastUserText = performance.now();
        this.lastActivity = Date.now();
        this.set(this.state.phase === "speaking" ? "interrupted" : "user_speaking", {
          partial: this.timeline.partial().slice(-240),
        });
        break;
      case "session.output_transcript.delta":
        this.timeline.add("assistant", event.delta ?? "", performance.now());
        this.lastActivity = Date.now();
        break;
      case "session.delegation.created":
        if (event.delegation?.target === "client") void this.onDelegation(event.delegation.id);
        break;
      case "session.usage.updated":
        this.usageSeconds = event.usage?.seconds ?? this.usageSeconds;
        break;
      case "session.closed":
        this.usageSeconds = event.usage?.seconds ?? this.usageSeconds;
        if (!this.ended && (event.reason === "expired" || event.reason === "connection_lost"))
          this.onConnectionLost();
        break;
      case "error":
        // Moderation may cut speech without ending the session; nothing to do but listen.
        break;
    }
  }

  // ── Delegations: GPT-Live → ELISE's turn engine ──────────────────────────────

  private async onDelegation(id: string) {
    if (this.delegations.some((d) => d.id === id)) return; // never twice
    // The delegation can arrive before the sentence is fully transcribed: wait for it to settle.
    const deadline = performance.now() + 2_500;
    while (performance.now() < deadline && performance.now() - this.lastUserText < SETTLE_MS)
      await sleep(80);
    let text = this.timeline.takeRequest();
    const delegation: Delegation = {
      id,
      text,
      createdAt: Date.now(),
      startedAt: null,
      done: false,
    };
    this.delegations.push(delegation);
    if (!text) {
      this.append(
        "session.commentary.append",
        id,
        this.deps.locale === "es"
          ? "No llegué a entender el pedido. Pedile que lo repita."
          : "The request didn't come through. Ask them to repeat it.",
      );
      delegation.done = true;
      return;
    }
    const running = this.active && !this.active.done ? this.active : null;
    if (running && isCancellation(text)) {
      this.deps.stop();
    } else if (running && running.startedAt && Date.now() - running.startedAt < REPLACE_WITHIN_MS) {
      // A quick correction or addition replaces the request that just started.
      this.deps.stop();
      text = `${running.text} — ${text}`;
      delegation.text = text;
    }
    this.chain = this.chain.then(() => this.runDelegation(delegation));
  }

  private async runDelegation(d: Delegation) {
    // The interaction must exist once: wait for a first persist that may be creating it.
    if (this.persisting) await this.persisting;
    this.active = d;
    d.startedAt = Date.now();
    this.progressSent.clear();
    this.set("executing");
    try {
      await this.deps.send(d.text, {
        modality: "voice",
        voice: { durationMs: 0, language: this.deps.locale },
        live: {
          delegationId: d.id,
          sessionId: this.thread()?.kind === "session" ? this.thread()!.id : null,
        },
      });
    } finally {
      d.done = true;
      if (this.active === d) this.active = null;
    }
  }

  private onStream(event: Parameters<StreamListener>[0]) {
    if (!this.pc) return;
    const d = this.active;
    if (event.type === "turn_started" && !event.live) {
      // Typed while in Voice Mode: same interaction; the voice model hears about it quietly.
      this.append(
        "session.thinking.append",
        null,
        `${this.deps.locale === "es" ? "La persona escribió" : "The user typed"}: ${event.text.slice(0, 600)}`,
      );
      return;
    }
    if (!d) return;
    if (event.type === "tool_started" && !event.parentId) {
      const group = event.name.split(".")[0] ?? "";
      if (!this.progressSent.has(group)) {
        this.progressSent.add(group);
        const p = progressContent(event.name, this.deps.locale);
        if (p) this.append("session.thinking.append", d.id, p);
      }
      return;
    }
    if (event.type === "delegation" && event.delegationId === d.id) {
      const latest = this.delegations.at(-1);
      // An older request finishing after a newer one: its result is context, never announced.
      const stale = latest && latest.id !== d.id && !latest.done;
      this.append(
        stale ? "session.thinking.append" : "session.commentary.append",
        d.id,
        event.content,
      );
      this.set(event.result.status === "needs_approval" ? "waiting_approval" : "listening");
      return;
    }
    if (event.type === "finished" && event.failed && this.state.phase === "executing") {
      this.append(
        "session.commentary.append",
        d.id,
        this.deps.locale === "es"
          ? "ELISE no pudo completarlo ahora. Decilo con honestidad y ofrecé reintentar."
          : "ELISE couldn't complete it right now. Say so honestly and offer to retry.",
      );
      this.set("listening");
    }
  }

  private append(
    type: "session.commentary.append" | "session.thinking.append",
    delegationId: string | null,
    content: string,
  ) {
    if (this.channel?.readyState !== "open") return;
    this.channel.send(
      JSON.stringify({ type, event_id: crypto.randomUUID(), delegation_id: delegationId, content }),
    );
  }

  // ── Persistence of conversation-only turns ─────────────────────────────────

  /** The voice session created by the first persisted turn, before the chat knows about it. */
  private ownSessionId: string | null = null;
  private persisting: Promise<void> | null = null;
  private thread(): ThreadRef | null {
    return (
      this.deps.getThread() ??
      (this.ownSessionId ? { kind: "session", id: this.ownSessionId } : null)
    );
  }

  private persistSettled(): Promise<void> {
    if (this.persisting) return this.persisting;
    // No interaction yet and a delegation is creating it: persist once it exists.
    if (!this.thread() && this.active) return Promise.resolve();
    const turns = this.timeline.settled(performance.now());
    if (!turns.length) return Promise.resolve();
    this.persisting = this.persist(turns).finally(() => {
      this.persisting = null;
    });
    return this.persisting;
  }

  private async persist(turns: { role: "user" | "assistant"; text: string }[]) {
    try {
      const thread = this.thread();
      const res = await fetch("/api/voice/live/turns", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          conversationId: thread?.kind === "conversation" ? thread.id : null,
          sessionId: thread?.kind === "session" ? thread.id : null,
          turns,
        }),
      });
      if (!thread && res.ok)
        this.ownSessionId = ((await res.json()) as { sessionId: string }).sessionId;
    } catch {
      // Best effort: delegated turns are persisted by the backend regardless.
    }
  }

  // ── Audio levels: phases and real latency metrics ──────────────────────────

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    if (!this.inLevel) return;
    const now = performance.now();
    const mic = rms(this.inLevel);
    const out = this.outLevel ? rms(this.outLevel) : 0;
    if (mic > LOUD) {
      if (!this.micLoudSince) this.micLoudSince = now;
      this.lastLoudMic = now;
      this.lastActivity = Date.now();
      // Talking over ELISE: barge-in (GPT-Live stops itself; we time it).
      if (this.outLoud && !this.interruptAt && now - this.micLoudSince > 150)
        this.interruptAt = now;
    } else if (mic < SILENT) {
      if (this.micLoudSince && now - this.lastLoudMic > 300) {
        this.micLoudSince = 0;
        if (!this.outLoud) this.waitingFirstAudio = true;
      }
    }
    if (out > LOUD) {
      this.outQuietSince = 0;
      if (!this.outLoud) {
        this.outLoud = true;
        if (this.waitingFirstAudio && this.lastLoudMic) {
          this.firstAudioMs.push(Math.round(now - this.lastLoudMic));
          this.waitingFirstAudio = false;
        }
        if (this.state.phase !== "executing" && this.state.phase !== "waiting_approval")
          this.set("speaking", { partial: "" });
      }
    } else if (out < SILENT && this.outLoud) {
      if (!this.outQuietSince) this.outQuietSince = now;
      if (now - this.outQuietSince > 250) {
        this.outLoud = false;
        if (this.interruptAt) {
          this.interruptStopMs.push(Math.round(this.outQuietSince - this.interruptAt));
          this.interruptAt = 0;
        }
        if (this.state.phase === "speaking" || this.state.phase === "interrupted")
          this.set(this.active ? "executing" : "listening");
      }
    }
    if (!this.active && Date.now() - this.lastActivity > IDLE_SLEEP_MS) void this.sleepNow();
  };

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  toggleMute() {
    if (!this.mic) return;
    this.muted = !this.muted;
    for (const t of this.mic.getAudioTracks()) t.enabled = !this.muted;
    if (this.channel?.readyState === "open")
      this.channel.send(
        JSON.stringify({
          type: this.muted ? "session.input_audio.mute" : "session.input_audio.unmute",
        }),
      );
    this.set(this.muted ? "muted" : "listening");
  }

  /** Stops ELISE's audio right now (a tap); GPT-Live keeps listening. */
  interrupt() {
    if (this.audio) this.audio.muted = true;
    window.setTimeout(() => {
      if (this.audio) this.audio.muted = false;
    }, 400);
  }

  private async sleepNow() {
    await this.close("close_requested");
    this.set("sleeping", { sleep: "inactivity" });
  }

  private reconnecting = false;
  private onConnectionLost() {
    if (this.ended || this.reconnecting) return;
    this.reconnecting = true;
    // Delegated work keeps running over HTTP; only the audio session is renewed.
    void this.close("connection_lost").then(async () => {
      this.reconnecting = false;
      if (!this.ended) await this.start();
    });
  }

  visibility(hidden: boolean) {
    if (hidden && this.pc)
      void this.sleepNow().then(() => this.set("sleeping", { sleep: "hidden" }));
  }

  async end() {
    this.ended = true;
    await this.close("close_requested");
    this.set("idle", { partial: "", sleep: null });
  }

  private async close(reason: string) {
    if (!this.pc) return;
    if (this.channel?.readyState === "open") {
      this.channel.send(JSON.stringify({ type: "session.close" }));
      await sleep(300);
    }
    await this.persistSettled();
    this.reportMetrics(reason);
    this.teardown();
  }

  private reportMetrics(reason: string) {
    if (!this.liveSessionId) return;
    const body = {
      sessionId: this.thread()?.kind === "session" ? this.thread()!.id : null,
      liveSessionId: this.liveSessionId,
      usageSeconds: this.usageSeconds || undefined,
      connectMs: this.connectMs || undefined,
      firstAudioMs: this.firstAudioMs.slice(-200),
      interruptStopMs: this.interruptStopMs.slice(-200),
      delegations: this.delegations.length,
      closeReason: reason,
    };
    if (voiceDebug())
      ((window as unknown as { __eliseLive?: unknown[] }).__eliseLive ??= []).push(body);
    void fetch("/api/voice/live/metrics", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      keepalive: true,
    }).catch(() => undefined);
  }

  private teardown() {
    cancelAnimationFrame(this.raf);
    window.clearInterval(this.persistTimer);
    this.channel?.close();
    this.pc?.close();
    for (const t of this.mic?.getTracks() ?? []) t.stop();
    if (this.audio) this.audio.srcObject = null;
    void this.ctx?.close().catch(() => undefined);
    this.pc = null;
    this.channel = null;
    this.mic = null;
    this.ctx = null;
    this.inLevel = null;
    this.outLevel = null;
    this.liveSessionId = null;
    this.timeline = new TranscriptTimeline();
    this.delegations = [];
    this.outLoud = false;
    this.waitingFirstAudio = false;
  }

  dispose() {
    this.unsubscribe?.();
    this.offDraft?.();
    void this.end();
  }

  problem(): VoiceProblem | null {
    return this.state.problem;
  }
}

/** Development, or `localStorage["elise.voiceDebug"] = "1"`: timings kept in the page (never sent). */
function voiceDebug(): boolean {
  if (process.env.NODE_ENV !== "production") return true;
  try {
    return window.localStorage.getItem("elise.voiceDebug") === "1";
  } catch {
    return false;
  }
}

function analyser(ctx: AudioContext, stream: MediaStream): AnalyserNode {
  const node = ctx.createAnalyser();
  node.fftSize = 512;
  ctx.createMediaStreamSource(stream).connect(node);
  return node;
}

const buffers = new WeakMap<AnalyserNode, Float32Array<ArrayBuffer>>();
function rms(node: AnalyserNode): number {
  let buf = buffers.get(node);
  if (!buf) buffers.set(node, (buf = new Float32Array(node.fftSize)));
  node.getFloatTimeDomainData(buf);
  let sum = 0;
  for (const v of buf) sum += v * v;
  return Math.sqrt(sum / buf.length);
}

function iceGathered(pc: RTCPeerConnection, timeoutMs: number): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      pc.removeEventListener("icegatheringstatechange", check);
      resolve();
    };
    const check = () => pc.iceGatheringState === "complete" && done();
    pc.addEventListener("icegatheringstatechange", check);
    window.setTimeout(done, timeoutMs);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

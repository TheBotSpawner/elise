import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthContext } from "@/application/auth-context";
import { WorkspaceSession } from "@/application/workspace-service";
import { buildContextPackage } from "@/core/agents/context";
import { groupRecall } from "@/core/recall/model";
import type { WakeEngine } from "@/core/voice/device";
import {
  initialVoice,
  micCapturing,
  voiceReducer,
  wakeListening,
  type VoiceEvent,
  type VoiceState,
} from "@/core/voice/session";
import { SentenceChunker, toSpeakable } from "@/core/voice/speech-text";
import { VOICE_TURN } from "@/core/voice/turn";
import { emptyWorkspace } from "@/core/workspace/model";
import {
  VoiceController,
  type MicPort,
  type PlayerPort,
  type Transcriber,
  type VoicePrefs,
} from "@/features/voice/voice-controller";
import { OpenAISpeechInput, OpenAISpeechOutput } from "@/infrastructure/ai/openai/speech";

// ── Session state machine ────────────────────────────────────────────────────

const START: VoiceEvent = { type: "start", speak: true, bargeIn: true, continuous: true };
const run = (events: VoiceEvent[], from: VoiceState = initialVoice) =>
  events.reduce(voiceReducer, from);

describe("voice session state machine", () => {
  it("idle → arming → listening → user_speaking → finalizing → thinking ⇄ executing → speaking → listening", () => {
    const events: VoiceEvent[] = [
      START,
      { type: "mic_ready" },
      { type: "speech_start" },
      { type: "speech_end" },
      { type: "partial", text: "Preparame" },
      { type: "transcript", text: "Preparame para mi reunión" },
      { type: "tool_started" },
      { type: "tool_finished" },
      { type: "speaking" },
      { type: "reply_done", awaitingApproval: false },
    ];
    const seen: string[] = [];
    events.reduce((s, e) => {
      const next = voiceReducer(s, e);
      seen.push(next.phase);
      return next;
    }, initialVoice);
    expect(seen).toEqual([
      "arming",
      "listening",
      "user_speaking",
      "finalizing_input",
      "finalizing_input",
      "thinking",
      "executing",
      "thinking",
      "speaking",
      "listening",
    ]);
  });

  it("the microphone indicator is true exactly while ELISE may be capturing", () => {
    const listening = run([START, { type: "mic_ready" }]);
    expect(micCapturing(run([START]))).toBe(false); // still asking for permission
    expect(micCapturing(listening)).toBe(true);
    expect(micCapturing(run([{ type: "mute" }], listening))).toBe(false);
    expect(micCapturing(run([{ type: "sleep", reason: "inactivity" }], listening))).toBe(false);
    expect(micCapturing(run([{ type: "end" }], listening))).toBe(false);
    const speaking = run(
      [
        { type: "speech_start" },
        { type: "speech_end" },
        { type: "transcript", text: "hola" },
        { type: "speaking" },
      ],
      listening,
    );
    // With barge-in on, the mic stays open while she speaks — and the indicator says so.
    expect(micCapturing(speaking)).toBe(true);
    expect(micCapturing({ ...speaking, bargeIn: false })).toBe(false);
  });

  it("barge-in interrupts in the same session; without it, speech over ELISE is ignored", () => {
    const speaking = run([
      START,
      { type: "mic_ready" },
      { type: "speech_end" },
      { type: "transcript", text: "hola" },
      { type: "speaking" },
    ]);
    const barged = run([{ type: "barge_in" }, { type: "speech_start" }], speaking);
    expect(barged.phase).toBe("user_speaking");
    expect(run([{ type: "barge_in" }], { ...speaking, bargeIn: false }).phase).toBe("speaking");
    expect(run([{ type: "interrupt" }], speaking).phase).toBe("listening");
  });

  it("never invents a transcript: silence listens again, twice puts the session to sleep", () => {
    const listening = run([START, { type: "mic_ready" }]);
    const once = run([{ type: "speech_end" }, { type: "transcript", text: "  " }], listening);
    expect(once).toMatchObject({ phase: "listening", problem: "nothing_heard", misses: 1 });
    const twice = run([{ type: "speech_end" }, { type: "transcript", text: "" }], once);
    expect(twice).toMatchObject({ phase: "sleeping", sleep: "inactivity" });
  });

  it("an approval waiting after the reply listens for the answer; not continuous sleeps", () => {
    const replying = run([
      START,
      { type: "mic_ready" },
      { type: "speech_end" },
      { type: "transcript", text: "mandale el mail" },
    ]);
    expect(run([{ type: "reply_done", awaitingApproval: true }], replying).phase).toBe(
      "waiting_approval",
    );
    expect(
      run([{ type: "reply_done", awaitingApproval: false }], { ...replying, continuous: false })
        .phase,
    ).toBe("sleeping");
    const waiting = run([{ type: "reply_done", awaitingApproval: true }], replying);
    expect(run([{ type: "speech_start" }], waiting).phase).toBe("user_speaking");
  });

  it("sleep, wake, offline and failures are explicit states", () => {
    const listening = run([START, { type: "mic_ready" }]);
    const asleep = run([{ type: "sleep", reason: "hidden" }], listening);
    expect(asleep).toMatchObject({ phase: "sleeping", sleep: "hidden" });
    expect(run([{ type: "wake" }], asleep).phase).toBe("arming");
    expect(wakeListening(run([{ type: "wake_status", status: "listening" }], asleep))).toBe(true);
    const offline = run([{ type: "offline" }], listening);
    expect(offline).toMatchObject({ phase: "offline", problem: "network" });
    expect(run([{ type: "online" }], offline).phase).toBe("sleeping");
    expect(run([START, { type: "mic_failed", problem: "permission_denied" }])).toMatchObject({
      phase: "error",
      problem: "permission_denied",
    });
    const failed = run([{ type: "speech_end" }, { type: "transcription_failed" }], listening);
    expect(failed).toMatchObject({ phase: "listening", problem: "transcription_failed" });
  });
});

// ── What is spoken ───────────────────────────────────────────────────────────

describe("spoken text", () => {
  it("keeps the synthesis, drops what only makes sense on screen", () => {
    expect(
      toSpeakable(
        "**Tenés 3 temas** para la reunión [1]:\n- Propuesta\n- [Contrato](https://x.com/c)\nVer https://meet.google.com/abc",
      ),
    ).toBe("Tenés 3 temas para la reunión: Propuesta Contrato Ver");
  });

  it("splits a streamed answer into sentences as they complete", () => {
    const c = new SentenceChunker();
    const out: string[] = [];
    for (const delta of [
      "Sí. Tenés una reunión con Rod a las 12",
      ".5 no, ",
      "a las 12. Estoy buscan",
      "do el contexto.",
    ])
      out.push(...c.push(delta));
    out.push(...c.flush());
    expect(out).toEqual([
      "Sí. Tenés una reunión con Rod a las 12.5 no, a las 12.",
      "Estoy buscando el contexto.",
    ]);
  });

  it("cuts an over-long sentence at a natural boundary", () => {
    const c = new SentenceChunker();
    const long = "palabra, ".repeat(120);
    const parts = [...c.push(long), ...c.flush()];
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.length <= 600)).toBe(true);
  });
});

// ── The controller with fake audio and a manual clock ────────────────────────

class FakeMic implements MicPort {
  opened = 0;
  closed = 0;
  began = 0;
  recording = false;
  /** What the microphone hears right now (RMS). */
  input = 0.002;
  constructor(private readonly fail: Error | null = null) {}
  async open() {
    if (this.fail) throw this.fail;
    this.opened++;
  }
  begin() {
    this.began++;
    this.recording = true;
  }
  snapshot() {
    return this.recording ? new Blob(["snapshot-audio"]) : null;
  }
  async finish() {
    this.recording = false;
    return { blob: new Blob(["fake-audio"], { type: "audio/webm" }), durationMs: 1800 };
  }
  discard() {
    this.recording = false;
  }
  close() {
    this.closed++;
    this.recording = false;
  }
  rms() {
    return this.input;
  }
  level() {
    return 0.4;
  }
}

class FakePlayer implements PlayerPort {
  spoken: string[] = [];
  stopped = 0;
  chimes = 0;
  speaking = false;
  onStart: (() => void) | null = null;
  onIdle: (() => void) | null = null;
  onError: (() => void) | null = null;
  speak(text: string) {
    this.spoken.push(text);
    if (!this.speaking) {
      this.speaking = true;
      this.onStart?.();
    }
  }
  finishPlaying() {
    this.speaking = false;
    this.onIdle?.();
  }
  stop() {
    this.stopped++;
    this.speaking = false;
  }
  close() {}
  rms() {
    return this.speaking ? 0.1 : 0;
  }
  level() {
    return this.speaking ? 0.6 : 0;
  }
  chime() {
    this.chimes++;
  }
}

class FakeWake implements WakeEngine {
  running = false;
  started: Parameters<WakeEngine["start"]>[0] | null = null;
  async availability() {
    return "available" as const;
  }
  async install() {
    return true;
  }
  start(opts: Parameters<WakeEngine["start"]>[0]) {
    this.running = true;
    this.started = opts;
  }
  stop() {
    this.running = false;
  }
}

const PREFS: VoicePrefs = {
  speak: true,
  bargeIn: true,
  continuous: true,
  wakeEnabled: false,
  wakePhrase: "elise",
  language: "es",
};

function setup(
  opts: {
    transcripts?: (string | null)[];
    micError?: Error;
    prefs?: Partial<VoicePrefs>;
    wake?: boolean;
  } = {},
) {
  const mic = new FakeMic(opts.micError ?? null);
  const player = new FakePlayer();
  const wake = opts.wake ? new FakeWake() : null;
  const sent: { text: string; options: unknown }[] = [];
  const timings: Record<string, number>[] = [];
  const queue = [...(opts.transcripts ?? ["¿Qué tengo hoy?"])];
  const uploads: string[] = [];
  const transcribe: Transcriber = async (blob) => {
    uploads.push(await blob.text());
    const text = queue.length > 1 ? queue.shift()! : queue[0]!;
    return text === null ? null : { text, language: "es" };
  };
  let now = 0;
  let tick: (() => void) | null = null;
  const controller = new VoiceController(
    {
      createMic: () => mic,
      createPlayer: () => player,
      transcribe,
      send: (text, options) => sent.push({ text, options }),
      onState: () => {},
      onTimings: (t) => timings.push(t as Record<string, number>),
      micProblem: () => "permission_denied",
      now: () => now,
      every: (_ms, fn) => {
        tick = fn;
        return () => {
          if (tick === fn) tick = null;
        };
      },
      wake,
      online: () => true,
    },
    { ...PREFS, ...opts.prefs },
  );
  /** Advances the clock by `ms`, hearing `rms` the whole time. */
  const hear = async (ms: number, rms: number) => {
    mic.input = rms;
    for (let t = 0; t < ms; t += VOICE_TURN.tickMs) {
      now += VOICE_TURN.tickMs;
      tick?.();
      for (let i = 0; i < 8; i++) await Promise.resolve();
    }
  };
  /** One utterance in a calibrated room: quiet, speech, then the silence that ends it. */
  const say = async (speechMs = 800) => {
    await hear(VOICE_TURN.calibrateMs, 0.002);
    await hear(speechMs, 0.1);
    await hear(VOICE_TURN.endSilenceMs + 100, 0.002);
    await settle();
  };
  return { controller, mic, player, wake, sent, timings, uploads, hear, say };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("continuous voice controller", () => {
  it("never opens the microphone before the user starts, and releases it on end", async () => {
    const { controller, mic } = setup();
    expect(mic.opened).toBe(0);
    await controller.start();
    expect(mic.opened).toBe(1);
    expect(controller.state.phase).toBe("listening");
    controller.end();
    expect(mic.closed).toBe(1);
    expect(controller.state.phase).toBe("idle");
  });

  it("detects the end of the turn by itself and sends the transcript — no audio, modality voice", async () => {
    const { controller, sent, say } = setup();
    await controller.start();
    await say();
    expect(sent).toEqual([
      {
        text: "¿Qué tengo hoy?",
        options: {
          modality: "voice",
          voice: { durationMs: 1800, language: "es", wake: "off" },
        },
      },
    ]);
    expect(JSON.stringify(sent)).not.toContain("audio");
    expect(controller.state.phase).toBe("thinking");
  });

  it("uses the speculative transcript taken at the pause when nothing was said after it", async () => {
    const { controller, uploads, say } = setup();
    await controller.start();
    await say();
    expect(uploads).toEqual(["snapshot-audio"]); // one upload: the snapshot, not the final blob
  });

  it("a pause that sounds unfinished waits longer before ending the turn", async () => {
    const { controller, sent, hear } = setup({ transcripts: ["Quiero que me prepares la"] });
    await controller.start();
    await hear(VOICE_TURN.calibrateMs, 0.002);
    await hear(800, 0.1);
    await hear(VOICE_TURN.endSilenceMs + 200, 0.002);
    expect(sent).toHaveLength(0); // still the user's turn
    await hear(VOICE_TURN.unfinishedSilenceMs - VOICE_TURN.endSilenceMs, 0.002);
    await settle();
    expect(sent).toHaveLength(1);
  });

  it("speaks the reply by sentence and listens again in the same session (multi-turn)", async () => {
    const { controller, mic, player, sent, timings, say } = setup({
      transcripts: ["¿Qué tengo hoy?", "Contame más de la segunda"],
    });
    await controller.start();
    await say();
    controller.onStream({ type: "conversation" });
    controller.onStream({ type: "text", delta: "Hoy tenés dos reuniones. " });
    expect(controller.state.phase).toBe("speaking");
    controller.onStream({ type: "text", delta: "Te las dejé en pantalla." });
    controller.onStream({ type: "finished", failed: false });
    expect(player.spoken).toEqual(["Hoy tenés dos reuniones.", "Te las dejé en pantalla."]);
    player.finishPlaying();
    expect(controller.state.phase).toBe("listening");
    expect(timings).toHaveLength(1);
    expect(timings[0]).toMatchObject({
      speechStart: expect.any(Number),
      audioStart: expect.any(Number),
    });
    await say();
    expect(sent.map((s) => s.text)).toEqual(["¿Qué tengo hoy?", "Contame más de la segunda"]);
    expect(mic.opened).toBe(1); // one permission, one session
  });

  it("the user talking over ELISE stops her at once and becomes the next turn", async () => {
    const { controller, player, sent, hear, say } = setup({
      transcripts: ["¿Qué tengo hoy?", "No, pará, la de las tres"],
    });
    await controller.start();
    await say();
    controller.onStream({ type: "text", delta: "Esta es una respuesta larga. " });
    // Her own voice leaking into the mic (echo) does not interrupt her…
    await hear(VOICE_TURN.barge.calibrateMs + 400, 0.03);
    expect(player.stopped).toBe(0);
    // …the user clearly speaking over her does.
    await hear(VOICE_TURN.barge.holdMs + 50, 0.3);
    expect(player.stopped).toBe(1);
    expect(controller.state.phase).toBe("user_speaking");
    controller.onStream({ type: "text", delta: "Y sigue hablando. " });
    expect(player.spoken).toEqual(["Esta es una respuesta larga."]); // the old reply is dropped
    await hear(VOICE_TURN.endSilenceMs + 100, 0.002);
    await settle();
    expect(sent.at(-1)?.text).toBe("No, pará, la de las tres");
  });

  it("her own words coming back after a barge-in are dropped, not answered", async () => {
    const { controller, sent, hear, say } = setup({
      transcripts: ["¿Qué tengo hoy?", "Tenés dos reuniones hoy"],
    });
    await controller.start();
    await say();
    controller.onStream({ type: "text", delta: "Tenés dos reuniones hoy. " });
    await hear(VOICE_TURN.barge.calibrateMs, 0.03);
    await hear(VOICE_TURN.barge.holdMs + 50, 0.3);
    await hear(VOICE_TURN.endSilenceMs + 100, 0.002);
    await settle();
    expect(sent).toHaveLength(1);
    expect(controller.state.phase).toBe("listening");
  });

  it("without barge-in, speech over ELISE never interrupts (tap still does)", async () => {
    const { controller, player, say, hear } = setup({ prefs: { bargeIn: false } });
    await controller.start();
    await say();
    controller.onStream({ type: "text", delta: "Una respuesta. " });
    await hear(2000, 0.3);
    expect(player.stopped).toBe(0);
    controller.interrupt();
    expect(player.stopped).toBe(1);
    expect(controller.state.phase).toBe("listening");
  });

  it("an approval in the reply leaves the session waiting for the spoken answer", async () => {
    const { controller, player, say } = setup();
    await controller.start();
    await say();
    controller.onStream({ type: "tool_started" });
    expect(controller.state.phase).toBe("executing");
    controller.onStream({ type: "tool_finished", outcome: { status: "approval_required" } });
    controller.onStream({ type: "text", delta: "¿Lo envío? " });
    controller.onStream({ type: "finished", failed: false });
    player.finishPlaying();
    expect(controller.state.phase).toBe("waiting_approval");
  });

  it("sleeps after a long silence, closing the microphone", async () => {
    const { controller, mic, hear } = setup();
    await controller.start();
    await hear(VOICE_TURN.sleepAfterMs + VOICE_TURN.noSpeechMs + 1000, 0.002);
    expect(controller.state).toMatchObject({ phase: "sleeping", sleep: "inactivity" });
    expect(mic.closed).toBe(1);
    expect(micCapturing(controller.state)).toBe(false);
  });

  it("asleep, the on-device wake phrase wakes it with a chime and runs what followed", async () => {
    const { controller, mic, player, wake, sent } = setup({
      wake: true,
      prefs: { wakeEnabled: true },
    });
    controller.setWakeStatus("ready");
    await controller.start();
    controller.sleep("inactivity");
    expect(wake!.running).toBe(true);
    expect(wake!.started?.phrase).toBe("elise");
    expect(controller.state.wake).toBe("listening");
    wake!.started!.onWake("Morning Brief");
    await settle();
    expect(wake!.running).toBe(false);
    expect(player.chimes).toBe(1);
    expect(mic.opened).toBe(2);
    expect(sent.at(-1)).toMatchObject({ text: "Morning Brief" });
    expect(controller.state.phase).toBe("thinking");
  });

  it("never listens in the background: a hidden page sleeps and stops the wake engine", async () => {
    const { controller, mic, wake } = setup({ wake: true, prefs: { wakeEnabled: true } });
    controller.setWakeStatus("ready");
    await controller.start();
    controller.visibility(true);
    expect(controller.state).toMatchObject({ phase: "sleeping", sleep: "hidden" });
    expect(mic.closed).toBe(1);
    expect(wake!.running).toBe(false);
    controller.visibility(false);
    expect(wake!.running).toBe(true);
  });

  it("the wake engine never starts when the browser can't detect it locally", async () => {
    const { controller, wake } = setup({ wake: true, prefs: { wakeEnabled: true } });
    controller.setWakeStatus("unsupported");
    await controller.start();
    controller.sleep("inactivity");
    expect(wake!.running).toBe(false);
  });

  it("a dropped network pauses voice honestly and recovers to sleeping", async () => {
    const { controller, mic } = setup();
    await controller.start();
    controller.network(false);
    expect(controller.state).toMatchObject({ phase: "offline", problem: "network" });
    expect(mic.closed).toBe(1);
    controller.network(true);
    expect(controller.state.phase).toBe("sleeping");
  });

  it("muted, nothing is captured or sent", async () => {
    const { controller, sent, hear } = setup();
    await controller.start();
    controller.toggleMute();
    await hear(3000, 0.2);
    expect(sent).toHaveLength(0);
    expect(micCapturing(controller.state)).toBe(false);
    controller.toggleMute();
    expect(controller.state.phase).toBe("listening");
  });

  it("permission denied: a clear problem, no session, nothing sent", async () => {
    const { controller, sent } = setup({ micError: new Error("NotAllowedError") });
    await controller.start();
    expect(controller.state).toMatchObject({ phase: "error", problem: "permission_denied" });
    expect(sent).toEqual([]);
  });

  it("transcription failure says so, sends nothing and keeps listening", async () => {
    const { controller, sent, say } = setup({ transcripts: [null] });
    await controller.start();
    await say();
    expect(sent).toEqual([]);
    expect(controller.state).toMatchObject({ phase: "listening", problem: "transcription_failed" });
  });

  it("if speaking fails the text answer stands and the session continues", async () => {
    const { controller, player, say } = setup();
    await controller.start();
    await say();
    controller.onStream({ type: "text", delta: "Listo." });
    player.onError?.();
    controller.onStream({ type: "finished", failed: false });
    player.finishPlaying();
    expect(controller.state.problem).toBe("speech_failed");
    expect(controller.state.phase).toBe("listening");
  });

  it("the Orb level is the real mic level while listening", async () => {
    const { controller } = setup();
    expect(controller.level()).toBe(-1);
    await controller.start();
    expect(controller.level()).toBe(0.4);
  });
});

// ── Runtime context ──────────────────────────────────────────────────────────

describe("voice turns in the runtime", () => {
  const base = {
    user: { displayName: null, locale: "es" as const, timezone: "UTC" },
    now: new Date("2026-09-30T12:00:00Z"),
    availableCapabilities: [],
    history: [],
    userMessage: "¿Qué tengo hoy?",
  };

  it("spoken turns get spoken-reply guidance; the model never claims a spoken approval", () => {
    const voice = buildContextPackage({ ...base, modality: "voice" }).instructions;
    expect(voice).toContain("This turn is spoken");
    expect(voice).toContain("exactly one approval of this conversation is waiting");
    expect(voice).toContain("never that something is done");
    expect(buildContextPackage(base).instructions).not.toContain("This turn is spoken");
  });

  it("voice interactions are recalled and reopen on Home (no History thread)", () => {
    const [r] = groupRecall(
      [
        {
          chunkId: "c",
          sessionId: "s1",
          content: "User: we decided to redesign onboarding",
          startedAt: "2026-09-30T12:00:00Z",
          endedAt: "2026-09-30T12:01:00Z",
          similarity: 0.7,
          keywordMatched: true,
          score: 0.05,
        },
      ],
      [
        {
          id: "s1",
          conversationId: null,
          modality: "voice",
          title: "Onboarding",
          summary: null,
          topics: [],
          startedAt: "2026-09-30T12:00:00Z",
          lastActivityAt: "2026-09-30T12:01:00Z",
        },
      ],
    );
    expect(r).toMatchObject({ modality: "voice", url: "/?session=s1" });
  });

  it("a voice session keeps its own Live Workspace, saved against the session", async () => {
    const saved: Record<string, unknown>[] = [];
    const auth = {
      userId: "u",
      workspaceId: "w",
      db: {
        from: () => ({
          upsert: async (row: Record<string, unknown>, opts: { onConflict: string }) => {
            saved.push({ ...row, onConflict: opts.onConflict });
            return { error: null };
          },
        }),
      },
    } as unknown as AuthContext;
    const session = new WorkspaceSession(auth, { kind: "session", id: "sess-1" }, emptyWorkspace());
    session.apply([{ op: "turn", at: "2026-09-30T12:00:00Z" }]);
    await session.flush();
    expect(saved[0]).toMatchObject({
      session_id: "sess-1",
      conversation_id: null,
      onConflict: "session_id",
    });
  });
});

// ── OpenAI adapters (mocked network; CI needs no credentials) ─────────────────

describe("OpenAI speech adapters", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("streams transcript deltas and reports the language", async () => {
    const body = [
      'data: {"type":"transcript.text.delta","delta":"¿Qué"}',
      'data: {"type":"transcript.text.delta","delta":" tengo hoy?"}',
      'data: {"type":"transcript.text.done","text":"¿Qué tengo hoy?","languages":[{"code":"es"}]}',
      "",
    ].join("\n");
    const fetchMock = vi.fn(async () => new Response(body, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const events = [];
    for await (const e of new OpenAISpeechInput("k", "gpt-transcribe").transcribe({
      audio: new Uint8Array([1, 2, 3]),
      mimeType: "audio/webm;codecs=opus",
      language: null,
    }))
      events.push(e);
    expect(events).toEqual([
      { type: "partial", text: "¿Qué" },
      { type: "partial", text: "¿Qué tengo hoy?" },
      { type: "final", text: "¿Qué tengo hoy?", language: "es" },
    ]);
    const form = (fetchMock.mock.calls[0] as unknown as [string, { body: FormData }])[1].body;
    expect(form.get("model")).toBe("gpt-transcribe");
    expect(form.get("stream")).toBe("true");
    expect(form.get("language")).toBeNull(); // auto-detect
  });

  it("maps provider failures to honest errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 503 })),
    );
    const it = new OpenAISpeechInput("k", "gpt-transcribe").transcribe({
      audio: new Uint8Array([1]),
      mimeType: "audio/webm",
      language: "es",
    });
    await expect(it[Symbol.asyncIterator]().next()).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
    });
  });

  it("asks for streamable PCM with an allowlisted voice", async () => {
    const fetchMock = vi.fn(
      async () => new Response(new Uint8Array([0, 0, 1, 0]), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const out = new OpenAISpeechOutput("k", "gpt-4o-mini-tts");
    await out.synthesize({ text: "Hola", language: "es", voice: "not-a-voice" });
    const init = (fetchMock.mock.calls[0] as unknown as [string, { body: string }])[1];
    expect(JSON.parse(init.body)).toMatchObject({
      model: "gpt-4o-mini-tts",
      response_format: "pcm",
      voice: "marin",
    });
    expect(out.format).toEqual({ encoding: "pcm_s16le", sampleRate: 24000 });
  });
});

// ── Found in the browser pass ────────────────────────────────────────────────

describe("browser-pass regressions", () => {
  it("asking again (e.g. a spoken yes) reuses the pending approval instead of creating another", async () => {
    const { executeToolCall } = await import("@/core/agents/executor");
    const { makeCtx, makePorts } = await import("../../fixtures/core-fakes");
    const { ports, tasks, log } = makePorts();
    const task = await tasks.create({ title: "Revisar la propuesta" });
    const first = await executeToolCall(ports, makeCtx({ aiRunId: "run-1" }), {
      name: "tasks.delete",
      args: { taskId: task.id },
      idempotencyKey: "run-1:a",
    });
    const again = await executeToolCall(ports, makeCtx({ aiRunId: "run-2" }), {
      name: "tasks.delete",
      args: { taskId: task.id },
      idempotencyKey: "run-2:b",
    });
    expect(first.status).toBe("approval_required");
    expect(again).toMatchObject({
      status: "approval_required",
      approvalId: (first as { approvalId: string }).approvalId,
    });
    expect(log.approvals).toHaveLength(1);
    expect(tasks.tasks.has(task.id)).toBe(true); // still nothing done without approval
  });

  it("an empty result makes no Surface", async () => {
    const { surfacesFromOutcome } = await import("@/core/workspace/from-results");
    expect(
      surfacesFromOutcome(
        "habits.list",
        { status: "succeeded", display: { kind: "habits", progress: [] } },
        { key: "c" },
      ),
    ).toEqual([]);
  });

  it("a list shown now replaces the single card of an item it contains", async () => {
    const { supersededOps, surfacesFromOutcome, presentOps } =
      await import("@/core/workspace/from-results");
    const { applyOps } = await import("@/core/workspace/model");
    const task = {
      id: "t1",
      title: "Revisar la propuesta",
      description: null,
      notes: null,
      status: "pending" as const,
      priority: null,
      category: null,
      dueDate: null,
      completedAt: null,
      createdAt: "2026-09-30T12:00:00Z",
      updatedAt: "2026-09-30T12:00:00Z",
      provenance: {
        providerKey: "elise_native" as const,
        connectionId: "c",
        externalId: "t1",
        source: "ELISE",
      },
    };
    const at = "2026-09-30T12:00:00Z";
    let state = applyOps(
      emptyWorkspace(),
      presentOps(
        surfacesFromOutcome(
          "tasks.create",
          { status: "succeeded", display: { kind: "task", task, change: "created" } },
          { key: "a" },
        ),
        at,
      ),
    );
    const list = surfacesFromOutcome(
      "tasks.list",
      { status: "succeeded", display: { kind: "task_list", tasks: [task] } },
      { key: "b" },
    );
    state = applyOps(state, [...supersededOps(state, list, at), ...presentOps(list, at)]);
    expect(state.surfaces.map((s) => s.type)).toEqual(["task_list"]);
  });

  it("a long spoken answer stops at the limit and says the rest is on screen", async () => {
    const { controller, player, say } = setup();
    await controller.start();
    await say();
    for (let i = 0; i < 12; i++)
      controller.onStream({
        type: "text",
        delta: `Esta es la frase número ${i} de una respuesta larga. `,
      });
    controller.onStream({ type: "finished", failed: false });
    expect(player.spoken.at(-1)).toBe("El resto te lo dejo en pantalla.");
    expect(player.spoken.slice(0, -1).join(" ").length).toBeLessThanOrEqual(420);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthContext } from "@/application/auth-context";
import { voiceStages } from "@/application/voice-service";
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
import {
  acknowledgement,
  acknowledgements,
  ackIntent,
  pickAcknowledgement,
  predictIntent,
  progressLine,
  PROGRESS_AFTER_MS,
  PROGRESS_TTL_MS,
  stillSayable,
} from "@/core/voice/speech-plan";
import { SentenceChunker, SpokenSplitter, toSpeakable } from "@/core/voice/speech-text";
import { calibrateFloor, endVerdict, TurnDetector, VOICE_TURN } from "@/core/voice/turn";
import { emptyWorkspace } from "@/core/workspace/model";
import type { SpeakOptions } from "@/features/voice/speech-player";
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
      "Sí. Tenés una reunión con Alex a las 12",
      ".5 no, ",
      "a las 12. Estoy buscan",
      "do el contexto.",
    ])
      out.push(...c.push(delta));
    out.push(...c.flush());
    expect(out).toEqual([
      "Sí. Tenés una reunión con Alex a las 12.5 no, a las 12.",
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
  /** Every line with its options: validity is checked when a test "plays" it. */
  lines: { text: string; options: SpeakOptions }[] = [];
  stopped = 0;
  chimes = 0;
  speaking = false;
  onStart: (() => void) | null = null;
  onIdle: (() => void) | null = null;
  onError: (() => void) | null = null;
  speak(text: string, _language?: unknown, options: SpeakOptions = {}) {
    this.lines.push({ text, options });
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
  prepared: string[] = [];
  prepare(text: string) {
    this.prepared.push(text);
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
  const queue = [...(opts.transcripts ?? ["¿Cómo viene mi día?"])];
  const uploads: string[] = [];
  const transcribe: Transcriber = async (blob) => {
    uploads.push(await blob.text());
    const text = queue.length > 1 ? queue.shift()! : queue[0]!;
    return text === null ? null : { text, language: "es" };
  };
  let now = 0;
  let tick: (() => void) | null = null;
  const timers: { at: number; fn: () => void }[] = [];
  const warmed: string[] = [];
  const cancels: number[] = [];
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
      later: (ms, fn) => void timers.push({ at: now + ms, fn }),
      warmAcknowledgements: (language) => void warmed.push(language),
      cancel: () => void cancels.push(now),
    },
    { ...PREFS, ...opts.prefs },
  );
  /** Moves the clock without audio; fires one-shot timers that came due. */
  const wait = (ms: number) => {
    now += ms;
    for (const t of timers.splice(0).filter((x) => (x.at <= now ? (x.fn(), false) : true)))
      timers.push(t);
  };
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
  return {
    controller,
    mic,
    player,
    wake,
    sent,
    timings,
    uploads,
    hear,
    say,
    wait,
    warmed,
    cancels,
  };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("continuous voice controller", () => {
  it("never opens the microphone before the user starts, and releases it on end", async () => {
    const { controller, mic, hear } = setup();
    expect(mic.opened).toBe(0);
    await controller.start();
    expect(mic.opened).toBe(1);
    // The room is measured first: "listening" only once speech can really be caught.
    expect(controller.state.phase).toBe("arming");
    await hear(VOICE_TURN.calibrateMs, 0.002);
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
        text: "¿Cómo viene mi día?",
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
      transcripts: ["¿Cómo viene mi día?", "Contame más de la segunda"],
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
    expect(sent.map((s) => s.text)).toEqual(["¿Cómo viene mi día?", "Contame más de la segunda"]);
    expect(mic.opened).toBe(1); // one permission, one session
  });

  it("the user talking over ELISE stops her at once and becomes the next turn", async () => {
    const { controller, player, sent, hear, say } = setup({
      transcripts: ["¿Cómo viene mi día?", "No, pará, la de las tres"],
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
    // The abandoned request keeps streaming ahead of the new one: none of it is spoken now…
    controller.onStream({ type: "spoken", delta: "Encontré tres noticias de ayer. " });
    controller.onStream({ type: "finished", failed: false });
    expect(player.spoken).toEqual(["Esta es una respuesta larga."]);
    // …the new turn speaks once its own request starts.
    controller.onStream({ type: "turn_started", text: "No, pará, la de las tres" });
    controller.onStream({ type: "spoken", delta: "Dale, te muestro la de las tres. " });
    controller.onStream({ type: "finished", failed: false });
    expect(player.spoken.at(-1)).toBe("Dale, te muestro la de las tres.");
  });

  it("her own words coming back after a barge-in are dropped, not answered", async () => {
    const { controller, sent, hear, say } = setup({
      transcripts: ["¿Cómo viene mi día?", "Tenés dos reuniones hoy"],
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
    const { controller, mic, player, wake, sent, hear } = setup({
      wake: true,
      prefs: { wakeEnabled: true },
    });
    controller.setWakeStatus("ready");
    await controller.start();
    await hear(VOICE_TURN.calibrateMs, 0.002);
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
    await hear(VOICE_TURN.calibrateMs, 0.002);
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
    const { controller, hear } = setup();
    expect(controller.level()).toBe(-1);
    await controller.start();
    await hear(VOICE_TURN.calibrateMs, 0.002);
    expect(controller.level()).toBe(0.4);
  });
});

describe("continuous voice: every follow-up is caught the first time (regression)", () => {
  /** User turn N, ELISE replies and finishes, user turn N+1 starts right away — 10 times. */
  for (const gapMs of [0, 100, 250, 500, 1000])
    it(`10 alternating turns, speaking ${gapMs} ms after ELISE stops`, async () => {
      const lines = Array.from({ length: 10 }, (_, i) => `Pregunta número ${i + 1}`);
      const { controller, player, sent, hear, say } = setup({ transcripts: [...lines] });
      await controller.start();
      await say(); // first turn: the room is measured once, while arming
      for (let turn = 1; turn < lines.length; turn++) {
        controller.onStream({ type: "conversation" });
        controller.onStream({ type: "text", delta: "Listo, ya lo tengo. " });
        controller.onStream({ type: "finished", failed: false });
        expect(controller.state.phase).toBe("speaking");
        player.finishPlaying();
        expect(controller.state.phase).toBe("listening");
        // No deaf window: the user may start at once, with no quiet moment to "calibrate".
        if (gapMs) await hear(gapMs, 0.002);
        await hear(700, 0.1);
        await hear(VOICE_TURN.endSilenceMs + 100, 0.002);
        await settle();
        expect(sent.map((x) => x.text)).toEqual(lines.slice(0, turn + 1));
      }
      expect(controller.state.problem).toBeNull();
    });

  it("an empty speculative transcript falls back to the whole utterance", async () => {
    // The snapshot (at the pause) comes back empty; the full utterance has the words.
    const { controller, sent, hear } = setup({ transcripts: ["", "¿Y qué tengo mañana?"] });
    await controller.start();
    await hear(VOICE_TURN.calibrateMs, 0.002);
    await hear(700, 0.1);
    await hear(VOICE_TURN.endSilenceMs + 100, 0.002);
    await settle();
    expect(sent.map((x) => x.text)).toEqual(["¿Y qué tengo mañana?"]);
  });

  it("the room is measured once per session, robustly, never per turn", () => {
    // Someone already talking in part of the window doesn't become the "noise".
    expect(calibrateFloor([0.002, 0.003, 0.002, 0.1, 0.12, 0.11, 0.1, 0.09])).toBeLessThan(0.01);
    // A "floor" louder than a quiet room is speech: capped.
    expect(calibrateFloor(Array(8).fill(0.2))).toBe(VOICE_TURN.maxFloor);
    // A detector with the session's floor hears speech from its first frame.
    const d = new TurnDetector(VOICE_TURN, { floor: 0.002 });
    const signals: string[] = [];
    for (let t = 0; t < 300; t += VOICE_TURN.tickMs) {
      const s = d.frame(0.1, t);
      if (s) signals.push(s);
    }
    expect(signals).toEqual(["speech_start"]);
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
    expect(voice).toContain("Never say that something is done");
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

  it("speaks the model's spoken synthesis, never the detailed display answer", async () => {
    const { controller, player, say } = setup();
    await controller.start();
    await say();
    controller.onStream({ type: "spoken", delta: "Tenés tres temas importantes. " });
    controller.onStream({ type: "spoken", delta: "Te los dejé en pantalla." });
    controller.onStream({
      type: "text",
      delta: "## Temas\n\n1. Contrato Initech: vence el viernes. ",
    });
    controller.onStream({ type: "text", delta: "2. Presupuesto. 3. Próxima entrega." });
    controller.onStream({ type: "finished", failed: false });
    expect(player.spoken).toEqual(["Tenés tres temas importantes.", "Te los dejé en pantalla."]);
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

describe("spoken vs display (ADR-019)", () => {
  const run = (deltas: string[]) => {
    const s = new SpokenSplitter();
    const out = { spoken: "", display: "" };
    for (const d of deltas) {
      const p = s.push(d);
      out.spoken += p.spoken;
      out.display += p.display;
    }
    const p = s.flush();
    return { spoken: out.spoken + p.spoken, display: out.display + p.display };
  };

  it("separates the spoken synthesis from the display answer, across any delta split", () => {
    const text =
      "<spoken>Tenés tres temas para la reunión. Te los dejé abiertos.</spoken>\n\n## Temas\n- Contrato\n- Presupuesto";
    const whole = run([text]);
    expect(whole).toEqual({
      spoken: "Tenés tres temas para la reunión. Te los dejé abiertos.",
      display: "## Temas\n- Contrato\n- Presupuesto",
    });
    // Every possible split point (tags cut in the middle included) gives the same result.
    for (let i = 1; i < text.length; i++)
      expect(run([text.slice(0, i), text.slice(i)])).toEqual(whole);
    expect(run(text.split(""))).toEqual(whole);
  });

  it("keeps narration before tools spoken and supports several spoken parts", () => {
    expect(
      run(["<spoken>Dejame revisar.</spoken>", "<spoken>Listo, tenés dos.</spoken>Detalle"]),
    ).toEqual({ spoken: "Dejame revisar.Listo, tenés dos.", display: "Detalle" });
  });

  it("a reply without tags is display only; a stray '<' is just text", () => {
    expect(run(["Hoy tenés 2 < 3 reuniones."])).toEqual({
      spoken: "",
      display: "Hoy tenés 2 < 3 reuniones.",
    });
    expect(run(["Termina con <spo"])).toEqual({ spoken: "", display: "Termina con <spo" });
  });
});

// ── Voice + Canvas on one lifecycle (ADR-028) ───────────────────────────────

describe("speech follows the real state of the work", () => {
  /** What would actually be heard if each queued line started playing now. */
  const audible = (p: FakePlayer) =>
    p.lines.filter((l) => !l.options.valid || l.options.valid()).map((l) => l.text);

  it("acknowledges as soon as the work starts, concurrently with the tool", async () => {
    const { controller, player, say, timings } = setup();
    await controller.start();
    await say();
    controller.onStream({ type: "conversation" });
    controller.onStream({ type: "tool_started", name: "web.discover" });
    // The ack is queued at ACTIVITY_STARTED, before any result exists.
    expect(player.spoken).toEqual(["Lo busco."]);
    expect(audible(player)).toEqual(["Lo busco."]);
    player.lines[0]!.options.onBegin?.();
    controller.onStream({ type: "workspace" });
    controller.onStream({ type: "tool_finished", outcome: { status: "succeeded" } });
    controller.onStream({ type: "spoken", delta: "Encontré seis publicaciones. " });
    controller.onStream({ type: "finished", failed: false });
    player.finishPlaying();
    expect(timings[0]).toMatchObject({
      ackReady: expect.any(Number),
      ackTts: expect.any(Number),
      firstTool: expect.any(Number),
      firstSurface: expect.any(Number),
      toolsDone: expect.any(Number),
      resultSpeech: expect.any(Number),
    });
  });

  it("a progress line not yet played when results arrive is dropped — never 'voy a buscar' after the Canvas", async () => {
    const { controller, player, say } = setup();
    await controller.start();
    await say();
    controller.onStream({ type: "tool_started", name: "location.getRoute" });
    controller.onStream({ type: "workspace" });
    controller.onStream({ type: "tool_finished", outcome: { status: "succeeded" } });
    controller.onStream({ type: "spoken", delta: "Son unos 18 minutos en auto. " });
    // The ack's moment passed (the route is on screen and the result is being said).
    expect(audible(player)).toEqual(["Son unos 18 minutos en auto."]);
  });

  it("the model's own preamble is released when the tool starts, not after it finishes", async () => {
    const { controller, player, say } = setup();
    await controller.start();
    await say();
    // No trailing space: before, this sentence waited for the post-tool answer to be spoken.
    controller.onStream({ type: "spoken", delta: "Dejame revisar tu agenda." });
    expect(player.spoken).toEqual([]);
    controller.onStream({ type: "tool_started", name: "calendar.listEvents" });
    expect(player.spoken).toEqual(["Dejame revisar tu agenda."]);
    // …and no second, deterministic acknowledgement on top of it.
    controller.onStream({ type: "tool_started", name: "email.search" });
    expect(player.spoken).toHaveLength(1);
  });

  it("results, approvals and conversational replies are never dropped; instant tools get no ack", async () => {
    const { controller, player, say } = setup();
    await controller.start();
    await say();
    controller.onStream({ type: "tool_started", name: "settings.update" });
    expect(player.spoken).toEqual([]);
    controller.onStream({ type: "tool_finished", outcome: { status: "approval_required" } });
    controller.onStream({ type: "spoken", delta: "¿Lo cambio? " });
    controller.onStream({ type: "finished", failed: false });
    expect(audible(player)).toEqual(["¿Lo cambio?"]);
  });

  it("a stale progress line expires even while work continues", () => {
    const line = { category: "progress" as const, createdAt: 0 };
    const running = { running: 1, started: true, resultQueued: false };
    expect(stillSayable(line, running, 1_000)).toBe(true);
    expect(stillSayable(line, running, PROGRESS_TTL_MS + 1)).toBe(false);
    expect(stillSayable(line, { ...running, running: 0 }, 1_000)).toBe(false);
    expect(
      stillSayable({ ...line, category: "result" }, { ...running, resultQueued: true }, 99_000),
    ).toBe(true);
    expect(acknowledgement("knowledge.search", "es")).toBe("Reviso el material.");
    expect(acknowledgement("history.search", "en")).toBe("Searching our conversations.");
    expect(acknowledgement("ui.present", "es")).toBeNull();
  });

  it("an interruption stops speech at once; nothing queued plays after it", async () => {
    const { controller, player, say } = setup();
    await controller.start();
    await say();
    controller.onStream({ type: "tool_started", name: "web.search" });
    controller.interrupt();
    expect(player.stopped).toBeGreaterThan(0);
    expect(audible(player)).toEqual([]);
  });
});

// ── Acknowledgements (ADR-034) ───────────────────────────────────────────────

describe("acknowledgements: short, varied, honest", () => {
  const audible = (p: FakePlayer) =>
    p.lines.filter((l) => !l.options.valid || l.options.valid()).map((l) => l.text);

  it("classifies the work from the tool, without a model call", () => {
    expect(ackIntent("calendar.listEvents")).toBe("check_calendar");
    expect(ackIntent("knowledge.search")).toBe("search_knowledge");
    expect(ackIntent("web.searchNews")).toBe("search_web");
    expect(ackIntent("history.search")).toBe("search_recall");
    expect(ackIntent("location.getRoute")).toBe("map_route");
    expect(ackIntent("tasks.create")).toBe("create");
    expect(ackIntent("calendar.updateEvent")).toBe("update");
    expect(ackIntent("email.send")).toBe("risky");
    expect(ackIntent("calendar.deleteEvent")).toBe("risky");
    expect(ackIntent("ui.show")).toBeNull();
    expect(ackIntent("settings.update")).toBeNull();
  });

  it("before a mutation succeeds, never 'listo'; a risky action is only prepared", () => {
    for (const locale of ["es", "en"] as const)
      for (const intent of ["create", "update", "risky"] as const)
        for (let i = 0; i < 4; i++) {
          const line = pickAcknowledgement(intent, locale, Array(i).fill(""));
          expect(line).not.toMatch(/listo|hecho|done|added|sent|enviad|borrad|deleted/i);
        }
    expect(acknowledgement("tasks.create", "es")).toBe("Lo hago.");
    expect(acknowledgement("email.send", "es")).toBe("Sí, lo preparo.");
  });

  it("rotates deterministically and avoids repeating a recent line", () => {
    const a = pickAcknowledgement("check_calendar", "es", []);
    const b = pickAcknowledgement("check_calendar", "es", [a]);
    const c = pickAcknowledgement("check_calendar", "es", [a, b]);
    expect(new Set([a, b, c]).size).toBe(3);
    // All used: the least recently said comes back.
    expect(pickAcknowledgement("check_calendar", "es", [b, c, a])).toBe(b);
    expect(pickAcknowledgement("check_calendar", "es", [a])).toBe(b); // same input, same line
  });

  it("speaks the user's language, and every line is short", () => {
    expect(pickAcknowledgement("search_web", "en")).toBe("Let me look it up.");
    for (const locale of ["es", "en"] as const)
      for (const line of acknowledgements(locale)) {
        expect(line.split(/\s+/).length).toBeLessThanOrEqual(8);
        expect(line).not.toMatch(/\b(eh|mmm|uh)\b/i);
      }
    const segundo = acknowledgements("es").filter((l) => /un segundo/i.test(l));
    expect(segundo.length).toBeLessThanOrEqual(1);
  });

  it("consecutive turns vary their acknowledgement", async () => {
    const { controller, player, say } = setup();
    await controller.start();
    const heard: string[] = [];
    for (let i = 0; i < 3; i++) {
      await say();
      controller.onStream({ type: "tool_started", name: "calendar.listEvents" });
      heard.push(player.spoken.at(-1)!);
      controller.onStream({ type: "tool_finished", outcome: { status: "succeeded" } });
      controller.onStream({ type: "spoken", delta: "Tenés dos reuniones. " });
      controller.onStream({ type: "finished", failed: false });
      player.finishPlaying();
    }
    expect(new Set(heard).size).toBe(3);
  });

  it("the acknowledgement is queued as the tool starts; nothing waits for it", async () => {
    const { controller, player, say, sent } = setup();
    await controller.start();
    await say();
    // The request went out before any speech (the work never waits for the acknowledgement)…
    expect(sent).toHaveLength(1);
    expect(player.spoken).toEqual([]);
    controller.onStream({ type: "tool_started", name: "knowledge.search" });
    // …and the acknowledgement is queued the moment the work starts.
    expect(player.spoken).toEqual(["Reviso el material."]);
  });

  it("no acknowledgement for a direct answer or a clarification (no tool ran)", async () => {
    const { controller, player, say } = setup();
    await controller.start();
    await say();
    controller.onStream({ type: "spoken", delta: "¿Te referís a la de las 10 o a la de las 11? " });
    controller.onStream({ type: "finished", failed: false });
    expect(player.spoken).toEqual(["¿Te referís a la de las 10 o a la de las 11?"]);
  });

  it("a very fast tool: the acknowledgement not yet playing is dropped, the result is said", async () => {
    const { controller, player, say } = setup();
    await controller.start();
    await say();
    controller.onStream({ type: "tool_started", name: "tasks.list" });
    controller.onStream({ type: "tool_finished", outcome: { status: "succeeded" } });
    controller.onStream({ type: "spoken", delta: "Tenés tres tareas. " });
    controller.onStream({ type: "finished", failed: false });
    expect(audible(player)).toEqual(["Tenés tres tareas."]);
  });

  it("one progress line after a real wait while work runs — never two, never after the result", async () => {
    const { controller, player, say, wait } = setup();
    await controller.start();
    await say();
    controller.onStream({ type: "tool_started", name: "meeting.prepare" });
    wait(PROGRESS_AFTER_MS - 100);
    expect(player.spoken).toEqual(["Preparo la reunión."]);
    wait(200);
    expect(player.spoken).toEqual(["Preparo la reunión.", progressLine("prepare_meeting", "es")!]);
    wait(PROGRESS_AFTER_MS * 3);
    expect(player.spoken).toHaveLength(2);
  });

  it("no progress once the result is coming, or after a failure", async () => {
    const quick = setup();
    await quick.controller.start();
    await quick.say();
    quick.controller.onStream({ type: "tool_started", name: "web.searchNews" });
    quick.controller.onStream({ type: "tool_finished", outcome: { status: "succeeded" } });
    quick.controller.onStream({ type: "spoken", delta: "Hay tres noticias. " });
    quick.wait(PROGRESS_AFTER_MS + 10);
    expect(quick.player.spoken).not.toContain(progressLine("search_web", "es"));

    const failing = setup();
    await failing.controller.start();
    await failing.say();
    failing.controller.onStream({ type: "tool_started", name: "calendar.listEvents" });
    failing.controller.onStream({ type: "tool_started", name: "email.search" });
    failing.controller.onStream({ type: "tool_finished", outcome: { status: "failed" } });
    failing.wait(PROGRESS_AFTER_MS + 10);
    expect(failing.player.spoken).not.toContain(progressLine("check_calendar", "es"));
  });

  it("a new turn (barge-in or interruption) invalidates the old acknowledgement and progress", async () => {
    const { controller, player, say, wait } = setup();
    await controller.start();
    await say();
    controller.onStream({ type: "tool_started", name: "web.searchNews" });
    controller.interrupt();
    expect(audible(player)).toEqual([]);
    wait(PROGRESS_AFTER_MS + 10);
    expect(player.spoken).toEqual(["Lo busco."]); // no progress for a turn that's gone
  });

  it("warms the acknowledgement audio once per session, in the user's language", async () => {
    const { controller, warmed } = setup();
    await controller.start();
    expect(warmed).toEqual(["es"]);
  });
});

describe("acknowledging from the words, before the model picks a tool (ADR-034)", () => {
  it("predicts only plain lookups, never actions or chit-chat", () => {
    expect(predictIntent("Buscame las últimas noticias sobre inteligencia artificial.")).toBe(
      "search_web",
    );
    expect(predictIntent("¿Cuánto tardo en auto hasta el Obelisco?")).toBe("map_route");
    expect(predictIntent("Buscá en mis apuntes cuándo es el parcial.")).toBe("search_knowledge");
    expect(predictIntent("¿Qué tareas tengo pendientes?")).toBe("check_tasks");
    expect(predictIntent("Mostrame mi calendario de la semana que viene.")).toBe("check_calendar");
    // Actions wait for the real tool; ambiguity gets a question, not "lo busco".
    expect(predictIntent("Mové la reunión.")).toBeNull();
    expect(predictIntent("Agregá una tarea: comprar pilas.")).toBeNull();
    expect(predictIntent("Mandale un mail a Ana.")).toBeNull();
    expect(predictIntent("¿Cuánto es dos más dos?")).toBeNull();
    expect(predictIntent("Hola")).toBeNull();
  });

  it("acknowledges at the transcript, once; the tool start adds nothing", async () => {
    const { controller, player, say, sent } = setup({
      transcripts: ["Buscame las últimas noticias sobre el clima."],
    });
    await controller.start();
    await say();
    expect(sent).toHaveLength(1); // the request went out with it, not after it
    expect(player.spoken).toEqual(["Lo busco."]);
    controller.onStream({ type: "tool_started", name: "web.searchNews" });
    expect(player.spoken).toEqual(["Lo busco."]);
  });

  it("if the answer comes first, the early acknowledgement not yet playing is dropped", async () => {
    const { controller, player, say } = setup({ transcripts: ["¿Qué tareas tengo pendientes?"] });
    await controller.start();
    await say();
    controller.onStream({ type: "spoken", delta: "Tenés una tarea pendiente para mañana. " });
    controller.onStream({ type: "finished", failed: false });
    const audible = player.lines.filter((l) => !l.options.valid || l.options.valid());
    expect(audible.map((l) => l.text)).toEqual(["Tenés una tarea pendiente para mañana."]);
  });
});

describe("voice turn latency (ADR-036)", () => {
  it("a complete-sounding phrase ends after a short silence, not the full second", async () => {
    const { controller, sent, hear } = setup({ transcripts: ["¿Qué tengo mañana?"] });
    await controller.start();
    await hear(VOICE_TURN.calibrateMs, 0.002);
    await hear(800, 0.1);
    await hear(VOICE_TURN.completeSilenceMs + 100, 0.002);
    await settle();
    expect(sent).toHaveLength(1);
    expect(VOICE_TURN.completeSilenceMs).toBeLessThan(VOICE_TURN.endSilenceMs);
  });

  it("the acknowledgement is chosen and its audio fetched at the pause, then played at the end", async () => {
    const { controller, player, say } = setup({
      transcripts: ["Buscame las últimas noticias sobre el clima."],
    });
    await controller.start();
    await say();
    expect(player.prepared).toEqual(["Lo busco."]);
    expect(player.spoken).toEqual(["Lo busco."]);
  });

  it("actions are never prepared from a provisional transcript", async () => {
    const { controller, player, say } = setup({
      transcripts: ["Mandale un mail a Juan diciendo que llego tarde."],
    });
    await controller.start();
    await say();
    expect(player.prepared).toEqual([]);
  });

  it("talking over the acknowledgement right after the turn ended continues that turn", async () => {
    const { controller, sent, hear, say } = setup({
      transcripts: ["Buscame las últimas noticias sobre el clima.", "en Córdoba para mañana."],
    });
    await controller.start();
    await say();
    expect(sent[0]!.text).toBe("Buscame las últimas noticias sobre el clima.");
    expect(controller.state.phase).toBe("speaking"); // the acknowledgement is playing
    // …and the user hadn't finished.
    await hear(VOICE_TURN.barge.calibrateMs, 0.002);
    await hear(VOICE_TURN.barge.holdMs + 50, 0.3);
    await hear(600, 0.1);
    await hear(VOICE_TURN.endSilenceMs + 100, 0.002);
    await settle();
    expect(sent[1]!.text).toBe(
      "Buscame las últimas noticias sobre el clima. en Córdoba para mañana.",
    );
  });

  it("still talking while ELISE thinks: the cut request is cancelled and continued, whole", async () => {
    const { controller, sent, hear, say, cancels } = setup({
      transcripts: ["Creá una tarea.", "para comprar pan mañana."],
    });
    await controller.start();
    await say();
    expect(sent[0]!.text).toBe("Creá una tarea.");
    expect(micCapturing(controller.state)).toBe(true); // the indicator tells the truth
    await hear(300, 0.1); // the user goes on
    expect(cancels).toHaveLength(1);
    expect(controller.state.phase).toBe("user_speaking");
    await hear(500, 0.1);
    await hear(VOICE_TURN.endSilenceMs + 100, 0.002);
    await settle();
    expect(sent[1]!.text).toBe("Creá una tarea. para comprar pan mañana.");
  });

  it("a cough after the turn doesn't cancel it; the tail ends on its own", async () => {
    const { controller, sent, hear, say, cancels } = setup({
      transcripts: ["¿Cómo viene mi día?"],
    });
    await controller.start();
    await say();
    await hear(100, 0.3); // a short noise
    await hear(4_000, 0.002);
    expect(cancels).toHaveLength(0);
    expect(sent).toHaveLength(1);
    expect(controller.state.tail).toBe(false);
    expect(micCapturing(controller.state)).toBe(false);
  });

  it("a continuation that can't be transcribed sends the original request again", async () => {
    const { controller, sent, hear, say } = setup({ transcripts: ["Creá una tarea.", ""] });
    await controller.start();
    await say();
    await hear(400, 0.1);
    await hear(VOICE_TURN.endSilenceMs + 100, 0.002);
    await settle();
    expect(sent.map((x) => x.text)).toEqual(["Creá una tarea.", "Creá una tarea."]);
  });

  it("an interruption after the answer started is a new turn, not a continuation", async () => {
    const { controller, sent, hear, say } = setup({
      transcripts: ["¿Cómo viene mi día?", "Otra cosa."],
    });
    await controller.start();
    await say();
    controller.onStream({ type: "spoken", delta: "Tenés dos reuniones hoy. " });
    await hear(VOICE_TURN.barge.calibrateMs, 0.002);
    await hear(VOICE_TURN.barge.holdMs + 50, 0.3);
    await hear(VOICE_TURN.endSilenceMs + 100, 0.002);
    await settle();
    expect(sent[1]!.text).toBe("Otra cosa.");
  });
});

describe("turn verdicts and latency stages (ADR-036)", () => {
  it("complete, unfinished, or not sure — only a clear sentence ends early", () => {
    expect(endVerdict("¿Qué tengo mañana?")).toBe("complete");
    expect(endVerdict("Buscame las noticias de hoy.")).toBe("complete");
    expect(endVerdict("Quiero que me digas y.")).toBe("unfinished");
    expect(endVerdict("Recordame llamar a")).toBe("unfinished");
    expect(endVerdict("Hola.")).toBe(null); // one word: wait the normal silence
    expect(endVerdict("bueno entonces")).toBe("unfinished");
    expect(endVerdict("Pasame el informe")).toBe(null); // no sentence end yet
  });

  it("each stage of a turn's latency is measured on its own", () => {
    expect(
      voiceStages({
        lastVoice: 1000,
        turnDetected: 1750,
        transcriptFinal: 1800,
        ackReady: 1802,
        audioStart: 2100,
      }),
    ).toEqual({
      turn_detection_ms: 750,
      stt_finalization_ms: 50,
      ack_selection_ms: 2,
      tts_first_audio_ms: 298,
      perceived_ms: 1100,
    });
  });
});

describe("narration (ADR-041): ELISE speaks first, then the conversation goes on", () => {
  it("speaks the scheduled conversation's script through the normal player, then listens", async () => {
    const { controller, player, hear } = setup();
    await controller.start();
    await hear(VOICE_TURN.calibrateMs, 0.002);
    await controller.narrate("Buen día. Hoy no tenés reuniones. Te dejé todo en pantalla.");
    expect(player.spoken.join(" ")).toContain("Hoy no tenés reuniones.");
    expect(controller.state.phase).toBe("speaking");
    player.finishPlaying();
    // Continuous voice: the user can follow up at once, as after any reply.
    expect(controller.state.phase).toBe("listening");
  });

  it("can be talked over like any reply", async () => {
    const { controller, player, hear } = setup();
    await controller.start();
    await hear(VOICE_TURN.calibrateMs, 0.002);
    await controller.narrate("Buen día. Hay una propuesta pendiente y cinco respuestas esperando.");
    expect(controller.state.phase).toBe("speaking");
    // Her voice in the room first (echo is calibrated), then the user over it.
    await hear(VOICE_TURN.barge.calibrateMs + 400, 0.03);
    await hear(VOICE_TURN.barge.holdMs + 50, 0.3);
    expect(player.stopped).toBeGreaterThan(0);
    expect(["user_speaking", "interrupted"]).toContain(controller.state.phase);
  });

  it("speaks even when replies are text-only: listening was asked for explicitly", async () => {
    const { controller, player, hear } = setup({ prefs: { speak: false } });
    await controller.start();
    await hear(VOICE_TURN.calibrateMs, 0.002);
    await controller.narrate("Buen día.");
    expect(player.spoken).toEqual(["Buen día."]);
  });
});

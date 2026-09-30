import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthContext } from "@/application/auth-context";
import { WorkspaceSession } from "@/application/workspace-service";
import { buildContextPackage } from "@/core/agents/context";
import { groupRecall } from "@/core/recall/model";
import { initialVoice, micOpen, voiceReducer, type VoiceState } from "@/core/voice/session";
import { SentenceChunker, toSpeakable } from "@/core/voice/speech-text";
import { emptyWorkspace } from "@/core/workspace/model";
import {
  VoiceController,
  type MicPort,
  type PlayerPort,
  type Transcriber,
} from "@/features/voice/voice-controller";
import { OpenAISpeechInput, OpenAISpeechOutput } from "@/infrastructure/ai/openai/speech";

// ── Session lifecycle ────────────────────────────────────────────────────────

const run = (events: Parameters<typeof voiceReducer>[1][], from: VoiceState = initialVoice) =>
  events.reduce(voiceReducer, from);

describe("voice session lifecycle", () => {
  it("idle → listening → transcribing → thinking → speaking → listening", () => {
    const phases = [
      { type: "start", speak: true },
      { type: "mic_ready" },
      { type: "speech_end" },
      { type: "partial", text: "Preparame" },
      { type: "transcript", text: "Preparame para mi reunión" },
      { type: "speaking" },
      { type: "reply_done" },
    ] as const;
    const seen: string[] = [];
    phases.reduce((s, e) => {
      const next = voiceReducer(s, e);
      seen.push(next.phase);
      return next;
    }, initialVoice);
    expect(seen).toEqual([
      "listening",
      "listening",
      "transcribing",
      "transcribing",
      "thinking",
      "speaking",
      "listening",
    ]);
  });

  it("the microphone is open only while listening", () => {
    const listening = run([{ type: "start", speak: true }]);
    expect(micOpen(listening)).toBe(true);
    expect(micOpen(run([{ type: "mute" }], listening))).toBe(false);
    expect(micOpen(run([{ type: "speech_end" }], listening))).toBe(false);
    expect(micOpen(run([{ type: "end" }], listening))).toBe(false);
  });

  it("interrupting ELISE goes back to listening in the same session", () => {
    const speaking = run([
      { type: "start", speak: true },
      { type: "speech_end" },
      { type: "transcript", text: "hola" },
      { type: "speaking" },
    ]);
    expect(run([{ type: "interrupt" }], speaking).phase).toBe("listening");
  });

  it("never invents a transcript: silence listens again, twice pauses the session", () => {
    const once = run([
      { type: "start", speak: true },
      { type: "speech_end" },
      { type: "transcript", text: "  " },
    ]);
    expect(once).toMatchObject({ phase: "listening", problem: "nothing_heard", misses: 1 });
    const twice = run([{ type: "speech_end" }, { type: "transcript", text: "" }], once);
    expect(twice).toMatchObject({ phase: "idle", problem: "nothing_heard" });
  });

  it("failures are explained and never end in a fake answer", () => {
    expect(
      run([
        { type: "start", speak: true },
        { type: "mic_failed", problem: "permission_denied" },
      ]),
    ).toMatchObject({
      phase: "idle",
      problem: "permission_denied",
    });
    const failed = run([
      { type: "start", speak: true },
      { type: "speech_end" },
      { type: "transcription_failed" },
    ]);
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

// ── The controller with fake audio ───────────────────────────────────────────

class FakeMic implements MicPort {
  opened = false;
  closed = false;
  began = 0;
  onSpeechEnd: (() => void) | null = null;
  constructor(private readonly fail: Error | null = null) {}
  async open() {
    if (this.fail) throw this.fail;
    this.opened = true;
  }
  begin() {
    this.began++;
  }
  async finish() {
    return {
      blob: new Blob(["fake-audio"], { type: "audio/webm" }),
      durationMs: 1800,
      heardSpeech: true,
    };
  }
  discard() {}
  close() {
    this.closed = true;
  }
  level() {
    return 0.4;
  }
}

class FakePlayer implements PlayerPort {
  spoken: string[] = [];
  stopped = 0;
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
  level() {
    return this.speaking ? 0.6 : 0;
  }
}

function setup(opts: { transcript?: string | null; micError?: Error } = {}) {
  const mic = new FakeMic(opts.micError ?? null);
  const player = new FakePlayer();
  const sent: { text: string; options: unknown }[] = [];
  const states: VoiceState[] = [];
  const timings: unknown[] = [];
  const transcribe: Transcriber = async (_blob, onPartial) => {
    if (opts.transcript === null) return null;
    onPartial("¿Qué tengo");
    return { text: opts.transcript ?? "¿Qué tengo hoy?", language: "es" };
  };
  const controller = new VoiceController(
    {
      createMic: () => mic,
      createPlayer: () => player,
      transcribe,
      send: (text, options) => sent.push({ text, options }),
      onState: (s) => states.push(s),
      onTimings: (t) => timings.push(t),
      micProblem: () => "permission_denied",
    },
    true,
  );
  return { controller, mic, player, sent, states, timings };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("voice controller", () => {
  it("never opens the microphone before the user starts, and releases it on end", async () => {
    const { controller, mic } = setup();
    expect(mic.opened).toBe(false);
    await controller.start();
    expect(mic.opened).toBe(true);
    expect(controller.state.phase).toBe("listening");
    controller.end();
    expect(mic.closed).toBe(true);
    expect(controller.state.phase).toBe("idle");
  });

  it("a spoken turn enters the same chat path with modality voice — transcript only, no audio", async () => {
    const { controller, mic, sent } = setup();
    await controller.start();
    mic.onSpeechEnd?.();
    await settle();
    expect(sent).toEqual([
      {
        text: "¿Qué tengo hoy?",
        options: { modality: "voice", voice: { durationMs: 1800, language: "es" } },
      },
    ]);
    expect(JSON.stringify(sent)).not.toContain("fake-audio");
    expect(controller.state.phase).toBe("thinking");
  });

  it("speaks the streamed reply by sentence, then keeps listening in the same session", async () => {
    const { controller, mic, player, timings } = setup();
    await controller.start();
    mic.onSpeechEnd?.();
    await settle();
    controller.onStream({ type: "conversation" });
    controller.onStream({ type: "text", delta: "Hoy tenés dos reuniones. " });
    expect(controller.state.phase).toBe("speaking");
    controller.onStream({ type: "text", delta: "Te las dejé en pantalla." });
    controller.onStream({ type: "finished", failed: false });
    expect(player.spoken).toEqual(["Hoy tenés dos reuniones.", "Te las dejé en pantalla."]);
    expect(controller.state.phase).toBe("speaking");
    player.finishPlaying();
    expect(controller.state.phase).toBe("listening");
    expect(mic.began).toBe(2); // listening again for the next turn
    expect(timings).toHaveLength(1);
  });

  it("interruption stops speech at once and ignores the rest of the old reply", async () => {
    const { controller, mic, player } = setup();
    await controller.start();
    mic.onSpeechEnd?.();
    await settle();
    controller.onStream({ type: "text", delta: "Esta es una respuesta larga. " });
    controller.interrupt();
    expect(player.stopped).toBe(1);
    expect(controller.state.phase).toBe("listening");
    controller.onStream({ type: "text", delta: "Y sigue hablando. " });
    controller.onStream({ type: "finished", failed: false });
    expect(player.spoken).toEqual(["Esta es una respuesta larga."]);
  });

  it("permission denied: a clear problem, no session, nothing sent", async () => {
    const { controller, sent } = setup({ micError: new Error("NotAllowedError") });
    await controller.start();
    expect(controller.state).toMatchObject({ phase: "idle", problem: "permission_denied" });
    expect(sent).toEqual([]);
  });

  it("transcription failure asks to retry and sends nothing", async () => {
    const { controller, mic, sent } = setup({ transcript: null });
    await controller.start();
    mic.onSpeechEnd?.();
    await settle();
    expect(sent).toEqual([]);
    expect(controller.state).toMatchObject({ phase: "listening", problem: "transcription_failed" });
  });

  it("if speaking fails the text answer stands and the session continues", async () => {
    const { controller, mic, player } = setup();
    await controller.start();
    mic.onSpeechEnd?.();
    await settle();
    controller.onStream({ type: "text", delta: "Listo." });
    player.onError?.();
    controller.onStream({ type: "finished", failed: false });
    player.finishPlaying();
    expect(controller.state.problem).toBe("speech_failed");
    expect(controller.state.phase).toBe("listening");
  });

  it("the Orb level is the real mic level while listening and ELISE's while speaking", async () => {
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

  it("spoken turns get spoken-reply guidance; approvals are never spoken", () => {
    const voice = buildContextPackage({ ...base, modality: "voice" }).instructions;
    expect(voice).toContain("This turn is spoken");
    expect(voice).toContain('A spoken "yes" is not an approval');
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
    const { controller, mic, player } = setup();
    await controller.start();
    mic.onSpeechEnd?.();
    await settle();
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

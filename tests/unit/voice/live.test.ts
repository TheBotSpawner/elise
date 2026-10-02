import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  isCancellation,
  liveInstructions,
  LIVE_APPEND_CHARS,
  progressContent,
  resultContent,
  TranscriptTimeline,
} from "@/core/voice/live";

/**
 * GPT-Live voice (ADR-026): transcript timeline, delegation requests, results and the
 * delegation adapter of the turn engine. OpenAI and the engine are mocked; real sessions are
 * validated manually in Chrome.
 */

describe("transcript timeline", () => {
  it("keeps a conversation-only exchange and hands only the new request to a delegation", () => {
    const t = new TranscriptTimeline();
    t.add("user", "Hola Elise, ", 0);
    t.add("assistant", "Hola, Leo. ", 600);
    t.add("user", "¿cómo estás?", 900); // still arriving while ELISE answered
    t.add("assistant", "Bien, ¿y vos?", 1_200);
    t.add("user", "¿Qué tengo hoy ", 5_000);
    t.add("user", "en el calendario?", 5_300);
    expect(t.takeRequest()).toBe("¿Qué tengo hoy en el calendario?");
    t.add("assistant", "Ya lo miro. Tenés una cita a las 12.", 6_000);
    // Persist: the greeting exchange only; the delegated request and its answer are the engine's.
    expect(t.settled(20_000)).toEqual([
      { role: "user", text: "Hola Elise, ¿cómo estás?" },
      { role: "assistant", text: "Hola, Leo. Bien, ¿y vos?" },
    ]);
    expect(t.settled(30_000)).toEqual([]);
  });

  it("never persists a turn that's still in progress (no partials)", () => {
    const t = new TranscriptTimeline();
    t.add("user", "Hola", 0);
    expect(t.settled(100)).toEqual([]);
    t.add("assistant", "¡Hola!", 500);
    expect(t.settled(600)).toEqual([{ role: "user", text: "Hola" }]);
    expect(t.settled(5_000)).toEqual([{ role: "assistant", text: "¡Hola!" }]);
  });

  it("a correction after ELISE's acknowledgement is its own request (the session merges it)", () => {
    const t = new TranscriptTimeline();
    t.add("user", "Creame una tarea para mañana: llamar a Ana", 0);
    expect(t.takeRequest()).toBe("Creame una tarea para mañana: llamar a Ana");
    t.add("assistant", "Dale.", 800);
    t.add("user", "No, perdón, el lunes", 2_000);
    expect(t.takeRequest()).toBe("No, perdón, el lunes");
  });

  it("the live caption is what the user is saying now", () => {
    const t = new TranscriptTimeline();
    t.add("user", "Mostrame  mis ", 0);
    t.add("user", "tareas", 100);
    expect(t.partial()).toBe("Mostrame mis tareas");
  });
});

describe("delegation text", () => {
  it("recognizes cancellations, not requests that merely contain the words", () => {
    for (const s of ["Dejalo.", "no, dejá eso", "Olvidalo", "Never mind", "cancelá"])
      expect(isCancellation(s), s).toBe(true);
    for (const s of [
      "Dejá un recordatorio para mañana",
      "Cancelá la reunión de las 10",
      "Paraguay",
    ])
      expect(isCancellation(s), s).toBe(false);
  });

  it("results are compact, say what's verified and never claim a pending action is done", () => {
    const done = resultContent(
      {
        status: "completed",
        spoken: "Tenés una cita a las 12.",
        facts: ["Cita con Buenos Aires 12:10–13:10"],
      },
      "es",
    );
    expect(done).toContain("Resultado verificado por ELISE");
    expect(done).toContain("En pantalla: Cita con Buenos Aires");
    const pending = resultContent(
      {
        status: "needs_approval",
        spoken: "Preparé el mail.",
        facts: [],
        approval: { summary: "Enviar mail a Ana" },
      },
      "es",
    );
    expect(pending).toContain("Pendiente de aprobación: Enviar mail a Ana");
    expect(pending).toContain("no está hecho");
    const long = resultContent({ status: "completed", spoken: "x".repeat(5_000), facts: [] }, "en");
    expect(long.length).toBeLessThanOrEqual(LIVE_APPEND_CHARS);
  });

  it("progress names real activity, never results", () => {
    expect(progressContent("calendar.listEvents", "es")).toContain("revisando el calendario");
    expect(progressContent("calendar.listEvents", "es")).toContain("no lo anticipes");
    expect(progressContent("ui.focus", "es")).toBeNull();
  });

  it("the voice prompt holds conversation and delegation policy, not backend rules", () => {
    const p = liveInstructions({ locale: "es", displayName: "Leonardo Melman" });
    expect(p).toContain("Política de delegación");
    expect(p).toContain("Delegá al backend cuando");
    expect(p).toContain("No delegues cuando");
    expect(p).toContain("Nunca inventes resultados");
    expect(p).toContain("solo el backend decide si quedó aprobada");
    expect(p).toContain("Leonardo");
    expect(p).not.toContain("knowledge.search");
    expect(p.length).toBeLessThan(5_000);
  });
});

// ── Delegation adapter (engine and OpenAI mocked) ───────────────────────────

const engine = vi.hoisted(() => ({
  prepareTurn: vi.fn(),
  events: [] as unknown[],
}));
vi.mock("@/application/chat-service", () => ({ prepareTurn: engine.prepareTurn }));
vi.mock("@/application/interaction-thread", () => ({ openThread: vi.fn() }));
vi.mock("@/application/recall-service", () => ({ queueRecallIndex: vi.fn() }));
const openai = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@/infrastructure/ai", () => ({ createLiveWebRtcSession: openai.create }));

function fakeAuth(over: { dup?: boolean; voice?: boolean } = {}) {
  const chain = {
    select: () => chain,
    eq: () => chain,
    limit: async () => ({ data: over.dup ? [{ id: "r1" }] : [] }),
  };
  return {
    userId: "user-1",
    workspaceId: "ws-1",
    email: "x@y.z",
    db: { from: () => chain },
    profile: {
      displayName: "Leo",
      locale: "es",
      timezone: "UTC",
      voice: { enabled: over.voice ?? true, speak: true, voice: "marin" },
    },
  } as never;
}

describe("Live delegation adapter", () => {
  beforeEach(() => {
    engine.prepareTurn.mockReset();
    openai.create.mockReset();
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    vi.stubEnv("VOICE_RUNTIME", "live");
  });

  const run = async (text: string, auth = fakeAuth(), events: unknown[] = []) => {
    engine.prepareTurn.mockResolvedValue({
      thread: { kind: "session", id: "s1" },
      runId: "r1",
      run: async (emit: (e: unknown) => void) => events.forEach(emit),
    });
    const { runDelegation } = await import("@/application/live-voice-service");
    const out: { type: string; [k: string]: unknown }[] = [];
    await runDelegation(
      auth,
      {
        delegationId: "d1",
        conversationId: null,
        sessionId: "s1",
        text,
        requestId: "q",
        receivedAt: 0,
      },
      (e) => out.push(e as never),
    );
    return out;
  };

  it("runs the request through the turn engine as a spoken, live-delivered turn", async () => {
    const out = await run("¿Qué tengo hoy?", fakeAuth(), [
      { type: "conversation", thread: { kind: "session", id: "s1" }, runId: "r1" },
      { type: "tool_started", callId: "c1", name: "calendar.listEvents" },
      { type: "spoken", delta: "Tenés una cita a las 12." },
      { type: "text", delta: "**12:10** Cita con Buenos Aires" },
    ]);
    expect(engine.prepareTurn).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        message: "¿Qué tengo hoy?",
        modality: "voice",
        sessionId: "s1",
        requestId: "live:d1",
        live: { delegationId: "d1" },
      }),
    );
    expect(out.map((e) => e.type)).toEqual([
      "conversation",
      "tool_started",
      "spoken",
      "text",
      "delegation",
    ]);
    expect(out.at(-1)).toMatchObject({
      delegationId: "d1",
      result: { status: "completed", spoken: "Tenés una cita a las 12." },
    });
  });

  it("a pending approval is reported as waiting, never as done", async () => {
    const out = await run("Mandale el mail a Ana", fakeAuth(), [
      {
        type: "tool_finished",
        callId: "c1",
        name: "email.sendDraft",
        outcome: {
          status: "approval_required",
          approvalId: "a1",
          summary: "Enviar mail a Ana",
          reason: "external",
        },
        durationMs: 5,
      },
      { type: "spoken", delta: "Preparé el mail. ¿Lo envío?" },
    ]);
    expect(out.at(-1)).toMatchObject({
      result: { status: "needs_approval", approval: { summary: "Enviar mail a Ana" } },
    });
  });

  it("a cancellation never runs the model", async () => {
    const out = await run("Dejalo.");
    expect(engine.prepareTurn).not.toHaveBeenCalled();
    expect(out).toEqual([
      expect.objectContaining({
        type: "delegation",
        result: expect.objectContaining({ status: "cancelled" }),
      }),
    ]);
  });

  it("a delegation runs once: a repeat is rejected", async () => {
    await expect(run("¿Qué tengo hoy?", fakeAuth({ dup: true }))).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(engine.prepareTurn).not.toHaveBeenCalled();
  });

  it("sessions are created server-side for signed-in users with voice on; the key never leaves", async () => {
    openai.create.mockResolvedValue({ sdp: "answer", id: "live_1" });
    const { createLiveSession } = await import("@/application/live-voice-service");
    await expect(createLiveSession(fakeAuth(), "offer-sdp")).resolves.toEqual({
      sdp: "answer",
      id: "live_1",
    });
    const args = openai.create.mock.calls[0]![0];
    expect(args).toMatchObject({ apiKey: "sk-test", sdp: "offer-sdp", voice: "marin" });
    // A privacy-preserving id: hashed, not the user id or email.
    expect(args.safetyIdentifier).toMatch(/^[0-9a-f]{32}$/);
    expect(args.safetyIdentifier).not.toContain("user-1");
    await expect(createLiveSession(fakeAuth({ voice: false }), "offer-sdp")).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
  });
});

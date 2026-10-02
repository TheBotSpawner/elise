import { describe, expect, it } from "vitest";

import { executeToolCall } from "@/core/agents/executor";
import { runElise, type RuntimeEvent } from "@/core/agents/runtime";
import type { ProviderFactory } from "@/core/agents/tools";
import type { ContextProfile, ContextStore } from "@/core/contexts/model";
import { matchShortcut, phraseConflicts } from "@/core/shortcuts/match";
import {
  parseSteps,
  phraseKey,
  stepsToCalls,
  validatePhrases,
  type NewShortcut,
  type Shortcut,
  type ShortcutStore,
} from "@/core/shortcuts/model";
import { TASK_TOOLS } from "@/core/tools/tasks";
import {
  approvalIntent,
  bindVoiceApproval,
  VOICE_APPROVAL_WINDOW_MS,
  type PendingForVoice,
} from "@/core/voice/approval";
import {
  BargeInDetector,
  isSelfEcho,
  looksUnfinished,
  TurnDetector,
  VOICE_TURN,
} from "@/core/voice/turn";
import { matchWake } from "@/core/voice/wake";
import { surfacesFromOutcome } from "@/core/workspace/from-results";
import { toolForAction } from "@/core/workspace/registry";

import { makeCtx, makePorts, ScriptedAI } from "../../fixtures/core-fakes";

// ── Turn detection ───────────────────────────────────────────────────────────

/** Feeds one RMS value for `ms`, collecting the detector's signals. */
function feed(d: TurnDetector, clock: { now: number }, ms: number, rms: number) {
  const out: string[] = [];
  for (let t = 0; t < ms; t += VOICE_TURN.tickMs) {
    clock.now += VOICE_TURN.tickMs;
    const s = d.frame(rms, clock.now);
    if (s) out.push(s);
  }
  return out;
}

describe("turn detection", () => {
  it("speech, a pause (snapshot), then the end of the turn after the silence", () => {
    const d = new TurnDetector();
    const c = { now: 0 };
    expect(feed(d, c, VOICE_TURN.calibrateMs, 0.002)).toEqual([]);
    expect(feed(d, c, 600, 0.1)).toEqual(["speech_start"]);
    expect(feed(d, c, VOICE_TURN.endSilenceMs + 50, 0.002)).toEqual(["pause", "end"]);
  });

  it("resuming after a pause is reported (the snapshot is stale) and the turn continues", () => {
    const d = new TurnDetector();
    const c = { now: 0 };
    feed(d, c, VOICE_TURN.calibrateMs, 0.002);
    feed(d, c, 500, 0.1);
    expect(feed(d, c, 700, 0.002)).toEqual(["pause"]);
    expect(feed(d, c, 300, 0.1)).toEqual(["resumed"]);
    expect(feed(d, c, VOICE_TURN.endSilenceMs + 50, 0.002)).toEqual(["pause", "end"]);
  });

  it("an unfinished-sounding transcript needs the longer silence", () => {
    const d = new TurnDetector();
    const c = { now: 0 };
    feed(d, c, VOICE_TURN.calibrateMs, 0.002);
    feed(d, c, 500, 0.1);
    d.unfinished(true);
    expect(feed(d, c, VOICE_TURN.endSilenceMs + 200, 0.002)).toEqual(["pause"]);
    expect(feed(d, c, VOICE_TURN.unfinishedSilenceMs, 0.002)).toEqual(["end"]);
  });

  it("noise below the calibrated floor is not speech; nothing said ends empty", () => {
    const d = new TurnDetector();
    const c = { now: 0 };
    feed(d, c, VOICE_TURN.calibrateMs, 0.02); // a noisy room
    expect(feed(d, c, 1000, 0.035)).toEqual([]); // still under floor × factor
    expect(feed(d, c, VOICE_TURN.noSpeechMs, 0.02)).toEqual(["no_speech"]);
  });

  it("a short click is not a turn", () => {
    const d = new TurnDetector();
    const c = { now: 0 };
    feed(d, c, VOICE_TURN.calibrateMs, 0.002);
    expect(feed(d, c, 100, 0.2)).toEqual(["speech_start"]);
    expect(feed(d, c, VOICE_TURN.endSilenceMs + 100, 0.002)).toEqual([]); // under minSpeechMs
  });

  it("a barge-in turn starts mid-speech with the earlier noise floor", () => {
    const d = new TurnDetector(VOICE_TURN, { floor: 0.002, resumed: true });
    const c = { now: 0 };
    expect(feed(d, c, 300, 0.1)).toEqual([]);
    expect(feed(d, c, VOICE_TURN.endSilenceMs + 50, 0.002)).toEqual(["pause", "end"]);
  });

  it("knows when a sentence sounds cut off", () => {
    expect(looksUnfinished("Quiero que me prepares la")).toBe(true);
    expect(looksUnfinished("Mandale un mail a Alex y")).toBe(true);
    expect(looksUnfinished("Prepare me for the meeting with")).toBe(true);
    expect(looksUnfinished("Tengo que pensar,")).toBe(true);
    expect(looksUnfinished("¿Qué tengo hoy?")).toBe(false);
    expect(looksUnfinished("Preparame para la reunión")).toBe(false);
    expect(looksUnfinished("")).toBe(false);
  });
});

describe("barge-in", () => {
  function run(det: BargeInDetector, ms: number, mic: number, out: number, clock: { now: number }) {
    let hit = false;
    for (let t = 0; t < ms; t += VOICE_TURN.tickMs) {
      clock.now += VOICE_TURN.tickMs;
      hit = det.frame(mic, out, clock.now) || hit;
    }
    return hit;
  }

  it("her own echo never triggers it; the user over her does, after a short hold", () => {
    const d = new BargeInDetector();
    const c = { now: 0 };
    expect(run(d, VOICE_TURN.barge.calibrateMs, 0.03, 0.1, c)).toBe(false);
    expect(run(d, 2000, 0.035, 0.12, c)).toBe(false); // louder output, louder echo
    expect(run(d, 150, 0.3, 0.1, c)).toBe(false); // a blip
    expect(run(d, VOICE_TURN.barge.holdMs + 50, 0.3, 0.1, c)).toBe(true);
  });

  it("with headphones (no coupling) a clear voice interrupts", () => {
    const d = new BargeInDetector();
    const c = { now: 0 };
    run(d, VOICE_TURN.barge.calibrateMs, 0.002, 0.1, c);
    expect(run(d, VOICE_TURN.barge.holdMs + 50, 0.08, 0.1, c)).toBe(true);
  });

  it("drops a transcript that is mostly what ELISE just said", () => {
    const said = "Hoy tenés dos reuniones y tres tareas pendientes.";
    expect(isSelfEcho("tenés dos reuniones y tres tareas", said)).toBe(true);
    expect(isSelfEcho("No, pará, la de las tres", said)).toBe(false);
    expect(isSelfEcho("sí", said)).toBe(false);
  });
});

// ── Wake phrase ──────────────────────────────────────────────────────────────

describe("wake phrase matching", () => {
  it("wakes only when the phrase opens the utterance, and keeps what followed", () => {
    expect(matchWake("Elise", "elise", 0.9)).toEqual({ matched: true, remainder: "" });
    expect(matchWake("Elise, Morning Brief", "elise", 0.9)).toEqual({
      matched: true,
      remainder: "Morning Brief",
    });
    expect(matchWake("Hey Elise preparame la reunión", "hey_elise", 0.9)).toMatchObject({
      matched: true,
      remainder: "preparame la reunión",
    });
    expect(matchWake("Liz", "liz", null).matched).toBe(true);
  });

  it("is strict: the name mid-sentence, another phrase or low confidence never wake", () => {
    expect(matchWake("le dije a Elise que venga", "elise", 0.9).matched).toBe(false);
    expect(matchWake("Liz", "elise", 0.9).matched).toBe(false);
    expect(matchWake("Elise", "liz", 0.9).matched).toBe(false);
    expect(matchWake("Elise", "elise", 0.2).matched).toBe(false);
    expect(matchWake("Hey", "hey_elise", 0.9).matched).toBe(false);
  });
});

// ── Voice approvals ──────────────────────────────────────────────────────────

const NOW = new Date("2026-10-01T15:00:00Z");
const pending = (over: Partial<PendingForVoice> = {}): PendingForVoice => ({
  id: crypto.randomUUID(),
  summary: "Send email to Alex",
  createdAt: new Date(NOW.getTime() - 30_000).toISOString(),
  sameInteraction: true,
  fromLastReply: true,
  ...over,
});
const bind = (text: string, p: PendingForVoice[], modality: "voice" | "text" = "voice") =>
  bindVoiceApproval({ text, modality, pending: p, now: NOW });

describe("voice approvals", () => {
  it("only a pure yes/no is an approval intent", () => {
    for (const t of [
      "Sí",
      "Sí, envialo",
      "Aprobalo",
      "Confirmo",
      "dale",
      "yes, send it",
      "Sí. Borrala",
      "sí, eliminala",
    ])
      expect(approvalIntent(t)).toBe("approve");
    for (const t of ["No", "Cancelalo", "Dejalo", "no, gracias"])
      expect(approvalIntent(t)).toBe("reject");
    for (const t of [
      "Sí, pero cambiá el asunto",
      "¿Sí?... qué tengo hoy",
      "no sé qué tengo mañana",
      "Borrá la tarea de mañana",
      "",
    ])
      expect(approvalIntent(t)).toBeNull();
  });

  it("resolves exactly one pending approval of this interaction's last reply", () => {
    const one = pending();
    expect(bind("Sí, envialo", [one])).toEqual({
      kind: "resolve",
      approvalId: one.id,
      summary: one.summary,
      decision: "approved",
    });
    expect(bind("Cancelalo", [one])).toMatchObject({ kind: "resolve", decision: "rejected" });
  });

  it("two pending: asks which, approves nothing", () => {
    expect(bind("Sí", [pending(), pending({ summary: "Delete task" })])).toEqual({
      kind: "ask",
      count: 2,
    });
  });

  it("refuses when unsure: expired, another interaction, not the last reply, typed, or none", () => {
    expect(
      bind("Sí", [
        pending({
          createdAt: new Date(NOW.getTime() - VOICE_APPROVAL_WINDOW_MS - 1).toISOString(),
        }),
      ]),
    ).toEqual({ kind: "none" });
    expect(bind("Sí", [pending({ sameInteraction: false })])).toEqual({ kind: "none" });
    expect(bind("Sí", [pending({ fromLastReply: false })])).toEqual({ kind: "none" });
    expect(bind("Sí", [pending()], "text")).toEqual({ kind: "none" });
    expect(bind("Sí", [])).toEqual({ kind: "none" });
  });
});

// ── Shortcuts ────────────────────────────────────────────────────────────────

function shortcut(over: Partial<Shortcut> & Pick<Shortcut, "name" | "phrases">): Shortcut {
  return {
    id: crypto.randomUUID(),
    description: null,
    enabled: true,
    language: "es",
    steps: [{ type: "daily_planning.start", config: {} }],
    contextId: null,
    requiresConfirmation: false,
    lastRunAt: null,
    runCount: 0,
    ...over,
  };
}

const ARRANCAMOS = shortcut({ name: "Arrancamos", phrases: ["Arrancamos"] });
const BRIEF = shortcut({
  name: "Morning Brief",
  phrases: ["Morning Brief"],
  steps: [{ type: "morning_brief.run", config: {} }],
});

describe("shortcut matching", () => {
  it("runs on the exact phrase, with courtesy words or the wake word around it", () => {
    for (const said of ["Arrancamos", "arrancamos.", "Elise, arrancamos", "Dale, arrancamos"])
      expect(matchShortcut(said, [ARRANCAMOS, BRIEF])).toMatchObject({
        kind: "match",
        shortcut: { name: "Arrancamos" },
      });
  });

  it("a question or a sentence that merely contains the phrase is normal conversation", () => {
    expect(matchShortcut("¿A qué hora arrancamos mañana?", [ARRANCAMOS])).toEqual({ kind: "none" });
    expect(matchShortcut("A qué hora arrancamos mañana", [ARRANCAMOS])).toEqual({ kind: "none" });
    expect(matchShortcut("arrancamos con la propuesta de Initech", [ARRANCAMOS])).toEqual({
      kind: "none",
    });
  });

  it("tolerates one recognizer slip on a long phrase, never on a short one", () => {
    expect(matchShortcut("Mornin Brief", [BRIEF])).toMatchObject({ kind: "match", exact: false });
    const go = shortcut({ name: "Go", phrases: ["vamos"] });
    expect(matchShortcut("vamo", [go])).toEqual({ kind: "none" });
  });

  it("disabled shortcuts never run; two matches are ambiguous", () => {
    expect(matchShortcut("Arrancamos", [{ ...ARRANCAMOS, enabled: false }])).toEqual({
      kind: "none",
    });
    const twin = shortcut({ name: "Arrancamos 2", phrases: ["arrancamos"] });
    expect(matchShortcut("arrancamos", [ARRANCAMOS, twin]).kind).toBe("ambiguous");
  });

  it("phrase conflicts compare the matching form", () => {
    expect(phraseConflicts(["ARRANCAMOS!"], [ARRANCAMOS])).toEqual(["Arrancamos"]);
    expect(phraseConflicts(["Empezamos"], [ARRANCAMOS])).toEqual([]);
    expect(phraseKey("  Mórning   Brief! ")).toBe("morning brief");
  });
});

describe("shortcut steps", () => {
  it("only allowlisted steps with allowlisted parameters are accepted", () => {
    expect(parseSteps([{ type: "study.start", config: { context: "Contabilidad" } }])).toEqual([
      { type: "study.start", config: { context: "Contabilidad", mode: "oral_exam" } },
    ]);
    expect(() => parseSteps([{ type: "shell.run", config: { cmd: "rm -rf /" } }])).toThrow();
    expect(() => parseSteps([{ type: "workspace.clear", config: { extra: 1 } }])).toThrow();
    expect(() => parseSteps([])).toThrow();
    expect(() =>
      parseSteps(Array.from({ length: 5 }, () => ({ type: "workspace.clear", config: {} }))),
    ).toThrow();
  });

  it("phrases are validated", () => {
    expect(validatePhrases([" Arrancamos ", "arrancamos ", "Start my day"])).toEqual([
      "Arrancamos",
      "arrancamos",
      "Start my day",
    ]);
    expect(() => validatePhrases(["ok"])).toThrow();
    expect(() => validatePhrases([])).toThrow();
  });

  it("steps become the existing tools, with the Shortcut's context as default", () => {
    const calls = stepsToCalls(
      parseSteps([
        { type: "morning_brief.run", config: {} },
        { type: "work.brief", config: {} },
        { type: "tasks.show_today", config: {} },
        { type: "appearance.set_theme", config: { theme: "dark" } },
      ]),
      { contextId: "ctx-initech", today: "2026-10-01" },
    );
    expect(calls.map((c) => c.name)).toEqual([
      "briefs.today",
      "work.brief",
      "tasks.list",
      "appearance.setTheme",
    ]);
    expect(calls[1]!.args).toMatchObject({ context: "ctx-initech", web: false });
    expect(calls[3]!.args).toEqual({ theme: "dark" });
  });
});

class FakeShortcuts implements ShortcutStore {
  items: Shortcut[] = [];
  async list() {
    return this.items;
  }
  async create(input: NewShortcut) {
    const s = shortcut({
      name: input.name,
      phrases: input.phrases,
      steps: input.steps,
      contextId: input.contextId ?? null,
      requiresConfirmation: input.requiresConfirmation ?? false,
    });
    this.items.push(s);
    return s;
  }
  async update(id: string, patch: Partial<NewShortcut> & { enabled?: boolean }) {
    const s = this.items.find((x) => x.id === id)!;
    Object.assign(s, patch);
    return s;
  }
  async remove(id: string) {
    this.items = this.items.filter((x) => x.id !== id);
  }
  async markRun() {}
}

const INITECH: ContextProfile = {
  id: "11111111-2222-4333-8444-555555555555",
  kind: "client",
  name: "Initech",
  description: null,
  aliases: [],
  icon: null,
  accent: null,
  status: "active",
  instructions: null,
  study: null,
  links: [],
  createdAt: NOW.toISOString(),
  updatedAt: NOW.toISOString(),
};

function shortcutPorts() {
  const { ports, log } = makePorts();
  const store = new FakeShortcuts();
  const contexts = { list: async () => [INITECH] } as unknown as ContextStore;
  ports.providers = {
    get: ((capability: string) =>
      capability === "shortcuts" ? store : contexts) as ProviderFactory["get"],
  };
  return { ports, store, log };
}

describe("shortcut tools", () => {
  const def = {
    name: "Initech Brief",
    phrases: ["Initech Brief"],
    steps: [{ type: "work.brief" }],
    context: "Initech",
  };

  it("propose saves nothing and shows a Surface whose Save builds the create call server-side", async () => {
    const { ports, store } = shortcutPorts();
    const out = await executeToolCall(ports, makeCtx(), { name: "shortcuts.propose", args: def });
    expect(out.status).toBe("succeeded");
    expect(store.items).toHaveLength(0);
    const [surface] = surfacesFromOutcome("shortcuts.propose", out, { key: "k" });
    expect(surface).toMatchObject({ type: "shortcut", state: "attention" });
    const call = toolForAction(
      { ...surface!, id: "s", createdAt: "", updatedAt: "" } as never,
      "save_shortcut",
      null,
    );
    expect(call).toMatchObject({
      name: "shortcuts.create",
      args: { name: "Initech Brief", context: INITECH.id },
    });
  });

  it("create stores a validated Shortcut bound to the context; a duplicate phrase is refused", async () => {
    const { ports, store } = shortcutPorts();
    const created = await executeToolCall(ports, makeCtx(), {
      name: "shortcuts.create",
      args: def,
    });
    expect(created.status).toBe("succeeded");
    expect(store.items[0]).toMatchObject({ name: "Initech Brief", contextId: INITECH.id });
    const again = await executeToolCall(ports, makeCtx(), {
      name: "shortcuts.create",
      args: { ...def, name: "Other", phrases: ["initech brief"] },
    });
    expect(again).toMatchObject({ status: "failed", error: { code: "CONFLICT" } });
  });

  it("an unknown step type is refused before anything is saved", async () => {
    const { ports, store } = shortcutPorts();
    const out = await executeToolCall(ports, makeCtx(), {
      name: "shortcuts.create",
      args: { ...def, steps: [{ type: "email.send_all" }] },
    });
    expect(out.status).toBe("failed");
    expect(store.items).toHaveLength(0);
  });

  it("deleting a Shortcut asks for approval first", async () => {
    const { ports, store } = shortcutPorts();
    await store.create({ name: "Arrancamos", phrases: ["Arrancamos"], steps: ARRANCAMOS.steps });
    const out = await executeToolCall(ports, makeCtx(), {
      name: "shortcuts.delete",
      args: { shortcut: "Arrancamos" },
    });
    expect(out.status).toBe("approval_required");
    expect(store.items).toHaveLength(1);
  });
});

describe("shortcut execution", () => {
  const collect = async (it: AsyncIterable<RuntimeEvent>) => {
    const out: RuntimeEvent[] = [];
    for await (const e of it) out.push(e);
    return out;
  };

  it("preset steps run through the executor before the model, and approvals still hold", async () => {
    const { ports, tasks, log } = makePorts();
    const task = await tasks.create({ title: "Revisar la propuesta" });
    const ai = new ScriptedAI([
      () => [
        { type: "text_delta", delta: "Listo." },
        { type: "completed", model: "test", usage: null },
      ],
    ]);
    const events = await collect(
      runElise({
        ai,
        ports,
        ctx: makeCtx(),
        instructions: "x",
        input: [],
        tools: TASK_TOOLS,
        preset: [
          { name: "tasks.list", args: { status: "open" } },
          { name: "tasks.delete", args: { taskId: task.id } },
        ],
      }),
    );
    const finished = events.filter((e) => e.type === "tool_finished");
    expect(finished.map((e) => e.type === "tool_finished" && e.outcome.status)).toEqual([
      "succeeded",
      "approval_required",
    ]);
    expect(tasks.tasks.has(task.id)).toBe(true); // a Shortcut never bypasses approval
    expect(log.approvals).toHaveLength(1);
    // The model saw the step results and only wrote the answer.
    expect(ai.requests[0]!.input.filter((i) => i.type === "tool_result")).toHaveLength(2);
  });
});

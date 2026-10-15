import { describe, expect, it } from "vitest";

import { executeToolCall } from "@/core/agents/executor";
import {
  canonicalHint,
  detectRepair,
  entityRefs,
  refNote,
  refsInNotes,
  repairHint,
  repairTool,
  resolveRepairTarget,
} from "@/core/agents/repair";
import { runElise, toolNotes, type RuntimeEvent } from "@/core/agents/runtime";
import { applyCanonicalCasing, findCanonicalReferences, type CanonicalMatch } from "@/core/lexicon";
import type { MethodSummary } from "@/core/skills/model";
import { planTurnMethods } from "@/core/skills/model";
import { normalizeEntityTitle } from "@/core/text";
import { TASK_TOOLS } from "@/core/tools/tasks";

import { makeCtx, makePorts, ScriptedAI } from "../../fixtures/core-fakes";

/**
 * Conversational repair (ADR-065): a correction of what ELISE just wrote fixes that same object,
 * without asking, without a duplicate, and without a Method getting in the way; known names
 * heard wrong ("Mielist") resolve to the canonical one ("Mi ELISE") when context backs it.
 */

async function turn(
  ports: ReturnType<typeof makePorts>["ports"],
  call: { name: string; args: unknown },
  over: Parameters<typeof makeCtx>[0] = {},
) {
  // Each turn is its own run (the executor replays a repeated run + call id as one write).
  const ctx = makeCtx({ aiRunId: crypto.randomUUID(), ...over });
  const ai = new ScriptedAI([
    () => [
      { type: "tool_call", callId: "c1", name: call.name, arguments: JSON.stringify(call.args) },
      { type: "completed", model: "test", usage: { inputTokens: 1, outputTokens: 1 } },
    ],
    () => [
      { type: "text_delta", delta: "Listo." },
      { type: "completed", model: "test", usage: { inputTokens: 1, outputTokens: 1 } },
    ],
  ]);
  const events: RuntimeEvent[] = [];
  for await (const e of runElise({
    ai,
    ports,
    ctx,
    instructions: "x",
    input: [],
    tools: TASK_TOOLS,
  }))
    events.push(e);
  const done = events.at(-1);
  if (done?.type !== "done") throw new Error("turn did not finish");
  return done.tools;
}

const PLANNING: MethodSummary = {
  id: "m-plan",
  name: "Planificación diaria en bloques",
  description: "Planificar el día en bloques: tareas, finanzas, reuniones y pendientes",
  hints: ["planificar el día", "tareas del día", "cargar tareas"],
  spaceId: null,
  platforms: ["web"],
  version: 1,
  updatedAt: "2026-10-01T00:00:00Z",
};

describe("the reported case: “cargar finanzas en Mielist”", () => {
  const first = "¿Me agregás, por favor, una tarea: cargar finanzas en Mielist?";
  const correction = "No, no, ahí te lo escribiste mal. Mielist como tu nombre, mi Elise.";

  it("fixes the same task with tasks.update, no question, no duplicate, no Method", async () => {
    const { ports, tasks } = makePorts();

    // Turn 1: speech recognition heard "Mielist"; the task is created as heard.
    const created = await turn(ports, {
      name: "tasks.create",
      args: { title: "cargar finanzas en Mielist" },
    });
    const [task] = [...tasks.tasks.values()];
    expect(task!.title).toBe("Cargar finanzas en Mielist");
    const history = [
      { role: "user", content: first },
      { role: "assistant", content: "Listo.", toolNotes: toolNotes(created) },
    ];

    // Turn 2: a correction, about the task just created.
    expect(detectRepair(correction)).toEqual({ kind: "correct" });
    const target = resolveRepairTarget(history, correction);
    expect(target).toMatchObject({ kind: "one", ref: { type: "task", id: task!.id } });
    const hint = repairHint({ kind: "correct" }, target, "es")!;
    expect(hint).toContain("tasks.update");
    expect(hint).toContain(task!.id);
    expect(hint).toMatch(/Don't ask whether to fix it/);
    expect(hint).toMatch(/never create a new one/);

    // "Mielist" + "como tu nombre": the product's own name, resolved.
    const names = findCanonicalReferences(correction);
    expect(names).toEqual([
      expect.objectContaining({
        kind: "resolved",
        ref: expect.objectContaining({ raw: "Mielist", resolved: "Mi ELISE" }),
      }),
    ]);

    // The planning Method that matched turn 1 is neither kept nor asked about.
    const methods = planTurnMethods({
      index: [PLANNING],
      spaces: [],
      message: correction,
      spaceIds: [],
      recentId: PLANNING.id,
      repair: true,
    });
    expect(methods.load).toBeNull();
    expect(methods.hint ?? "").not.toMatch(/update the Method/);

    // The model fixes it — even repeating the misheard word, the write comes out canonical.
    const aliases = names.flatMap((m) =>
      m.kind === "resolved" ? [{ from: m.ref.raw, to: m.ref.resolved }] : [],
    );
    const fixed = await turn(
      ports,
      { name: "tasks.update", args: { taskId: task!.id, title: "cargar finanzas en Mielist" } },
      { aliases },
    );
    expect(fixed.map((t) => [t.name, t.outcome.status])).toEqual([["tasks.update", "succeeded"]]);
    expect(tasks.tasks.size).toBe(1);
    expect(tasks.tasks.get(task!.id)!.title).toBe("Cargar finanzas en Mi ELISE");
    // The Surface reconciles from the write's target (same object).
    expect(fixed[0]!.outcome).toMatchObject({ target: { type: "task", id: task!.id } });

    // A chained correction now points at the corrected task, and "dejalo como estaba" knows
    // what it was.
    const later = [
      ...history,
      { role: "user", content: correction },
      { role: "assistant", content: "Corregido.", toolNotes: toolNotes(fixed) },
    ];
    expect(resolveRepairTarget(later, "Dejalo como estaba")).toMatchObject({
      kind: "one",
      ref: { displayName: "Cargar finanzas en Mi ELISE" },
      previous: "Cargar finanzas en Mielist",
    });
  });

  it("the plain version: “No, era Mi ELISE, como tu nombre.” writes Mi ELISE, never Mielist", async () => {
    const { ports, tasks } = makePorts();
    const created = await turn(ports, {
      name: "tasks.create",
      args: { title: "cargar finanzas en Mielist" },
    });
    const id = [...tasks.tasks.keys()][0]!;
    const msg = "No, era Mi ELISE, como tu nombre.";
    expect(detectRepair(msg)).toEqual({ kind: "correct" });
    expect(
      resolveRepairTarget([{ role: "assistant", toolNotes: toolNotes(created) }], msg),
    ).toMatchObject({ kind: "one", ref: { id } });
    await turn(ports, {
      name: "tasks.update",
      args: { taskId: id, title: "cargar finanzas en mi elise" },
    });
    expect(tasks.tasks.get(id)!.title).toBe("Cargar finanzas en Mi ELISE");
  });
});

describe("repair intent", () => {
  it.each([
    "No, está mal.",
    "Lo escribiste mal.",
    "Corregilo.",
    "Era Mi ELISE.",
    "Quise decir Marcos.",
    "No, no era eso.",
    "En realidad son 23.500.",
    "Cambialo por mandarinas.",
    "Me refería a la otra.",
    "Ahí te equivocaste.",
    "Ese nombre está mal.",
    "Ponelo como Mi ELISE.",
    "Eso último era leche.",
    "No, eran huevos y leche.",
    "No, Marcos con s.",
    "Mejor 15.",
    "No, fueron 23.500.",
    "No, leche.",
    "No, I meant My ELISE.",
    "You spelled that wrong.",
    "Change the last task to Call Marcos.",
    "Actually, make that 30 minutes.",
  ])("“%s” is a correction", (msg) => {
    expect(detectRepair(msg)).toEqual({ kind: "correct" });
  });

  it.each(["Dejalo como estaba.", "Deshacelo.", "Undo that."])("“%s” reverts", (msg) => {
    expect(detectRepair(msg)).toEqual({ kind: "revert" });
  });

  it.each([
    "Agregá huevos a Compras.",
    "Además agregá mandarinas.",
    "Capaz cambiale el nombre, no sé.",
    "Maybe change it later.",
    "No, gracias.",
    "¿Qué tengo mañana?",
  ])("“%s” is not", (msg) => {
    expect(detectRepair(msg)).toBeNull();
  });
});

const outcome = (o: Record<string, unknown>) =>
  ({ status: "succeeded", actionId: null, providerLabel: "ELISE", output: {}, ...o }) as never;

describe("one repair framework for every module", () => {
  const list = { id: "L1", name: "🛍️ Compras", items: [] };
  const writes: [string, ReturnType<typeof outcome>, string, string][] = [
    [
      "tasks.create",
      outcome({
        display: { kind: "task", change: "created", task: { id: "t1", title: "Llamar a Marco" } },
        target: { type: "task", id: "t1" },
      }),
      "task",
      "Llamar a Marco",
    ],
    [
      "lists.addItem",
      outcome({
        output: { added: ["Bananas"] },
        display: { kind: "native_list", list },
        target: { type: "list", id: "L1" },
      }),
      "list_item",
      "Bananas",
    ],
    [
      "habits.create",
      outcome({
        display: { kind: "habits", progress: [{ habitId: "h1", name: "Meditar 10 minutos" }] },
        target: { type: "habit", id: "h1" },
      }),
      "habit",
      "Meditar 10 minutos",
    ],
    [
      "goals.create",
      outcome({
        display: { kind: "goal", detail: { snapshot: { goal: { title: "Correr 10k" } } } },
        target: { type: "goal", id: "g1" },
      }),
      "goal",
      "Correr 10k",
    ],
    [
      "notes.create",
      outcome({
        display: { kind: "note", change: "created", note: { id: "n1", title: "Ideas" } },
        target: { type: "note", id: "n1" },
      }),
      "note",
      "Ideas",
    ],
    [
      "finance.createTransaction",
      outcome({
        display: {
          kind: "finance_transaction",
          change: "created",
          transaction: { description: "Supermercado", amount: "25000", currency: "ARS" },
        },
        target: { type: "finance_transaction", id: "f1" },
      }),
      "finance_transaction",
      "Supermercado · 25000 ARS",
    ],
  ];

  it.each(writes)("%s leaves a reference its update tool can fix", (name, o, type, label) => {
    const refs = entityRefs(name, o);
    expect(refs).toMatchObject([{ type, displayName: label, sourceAction: name }]);
    expect(refsInNotes([`${name} succeeded ${refs.map(refNote).join(" ")}`])).toEqual(refs);
    const target = resolveRepairTarget(
      [{ role: "assistant", toolNotes: [`${name} succeeded ${refs.map(refNote).join(" ")}`] }],
      "No, está mal.",
    );
    expect(target).toMatchObject({ kind: "one", ref: { type } });
    expect(repairHint({ kind: "correct" }, target, "es")).toContain(repairTool(type)!);
  });

  it("a list item is fixed by list and item, not recreated", () => {
    const refs = entityRefs("lists.addItem", writes[1]![1]);
    const hint = repairHint(
      { kind: "correct" },
      { kind: "one", ref: refs[0]!, previous: null },
      "es",
    );
    expect(hint).toContain("lists.updateItem");
    expect(hint).toContain('list "🛍️ Compras", item "Bananas"');
  });

  it("two different things just written: ask which, naming them", () => {
    const notes = [writes[0]!, writes[5]!].map(
      ([name, o]) => `${name} succeeded ${entityRefs(name, o).map(refNote).join(" ")}`,
    );
    const target = resolveRepairTarget(
      [{ role: "assistant", toolNotes: notes }],
      "Cambialo a Personal.",
    );
    expect(target).toMatchObject({ kind: "ambiguous" });
    expect(repairHint({ kind: "correct" }, target, "es")).toMatch(
      /¿la tarea "Llamar a Marco" o el movimiento "Supermercado · 25000 ARS"\?/,
    );
    // Naming the kind resolves it.
    expect(
      resolveRepairTarget([{ role: "assistant", toolNotes: notes }], "Cambiá el gasto a 23.500"),
    ).toMatchObject({ kind: "one", ref: { type: "finance_transaction" } });
  });

  it("nothing correctable just happened: no repair (normal conversation)", () => {
    expect(
      resolveRepairTarget(
        [{ role: "assistant", toolNotes: ["tasks.list ✓ 3 tasks"] }],
        "No, está mal.",
      ),
    ).toEqual({ kind: "none" });
    expect(repairHint({ kind: "correct" }, { kind: "none" }, "es")).toBeNull();
  });

  it("undoing a creation removes it through its own (approval-guarded) tool", () => {
    const ref = entityRefs("tasks.create", writes[0]![1])[0]!;
    expect(repairHint({ kind: "revert" }, { kind: "one", ref, previous: null }, "es")).toMatch(
      /tasks\.delete .*approval rules apply/,
    );
  });
});

describe("canonical names", () => {
  it.each([
    ["mi elise", "Mi ELISE"],
    ["Mi elise", "Mi ELISE"],
    ["mi ELISE", "Mi ELISE"],
    ["cargar finanzas en mi elise", "Cargar finanzas en Mi ELISE"],
    ["revisar rsfa", "Revisar RSFA"],
    ["mandar whatsapp a la utn", "Mandar WhatsApp a la UTN"],
    ["armar flujo en power automate y uipath", "Armar flujo en Power Automate y UiPath"],
    ["make dinner", "Make dinner"],
  ])("“%s” → “%s”", (raw, title) => {
    expect(normalizeEntityTitle(raw)).toBe(title);
  });

  it("casing never touches the middle of a word", () => {
    expect(applyCanonicalCasing("elisea y eliseo")).toBe("elisea y eliseo");
  });

  const kinds = (m: CanonicalMatch[]) =>
    m.map((x) => (x.kind === "ambiguous" ? [x.kind, x.raw] : [x.kind, x.ref.raw, x.ref.resolved]));

  it("high confidence: misheard + “como tu nombre” → resolved", () => {
    expect(kinds(findCanonicalReferences("mielist, como tu nombre"))).toEqual([
      ["resolved", "mielist", "Mi ELISE"],
    ]);
    expect(kinds(findCanonicalReferences("mielise como tu nombre"))).toEqual([
      ["resolved", "mielise", "Mi ELISE"],
    ]);
  });

  it("without context it's only a suggestion the model weighs", () => {
    const m = findCanonicalReferences("cargar finanzas en Mielist");
    expect(kinds(m)).toEqual([["suggested", "Mielist", "Mi ELISE"]]);
    expect(canonicalHint(m)).toMatch(/unless the user says it's a different name/);
  });

  it("a literal name is kept", () => {
    expect(findCanonicalReferences("Mi proyecto se llama Mielist, con T al final.")).toEqual([]);
    expect(findCanonicalReferences("Mielist es el nombre de una app externa que uso")).toEqual([]);
  });

  it("several known names → ask", () => {
    const m = findCanonicalReferences("Ponelo en Firbot.", ["Firbot Solutions", "Firbot Academy"]);
    expect(kinds(m)).toEqual([["ambiguous", "Firbot"]]);
    expect(canonicalHint(m)).toMatch(/"Firbot Solutions" or "Firbot Academy".*ask which/);
  });

  it("a similar real name is not turned into ELISE", () => {
    expect(findCanonicalReferences("Decile a Elisa que llego tarde")).toEqual([]);
    expect(findCanonicalReferences("Agregá mieles del sur a la lista")).toEqual([]);
  });

  it("the user's own names count too", () => {
    expect(kinds(findCanonicalReferences("agregalo a compraz", ["Compras"]))).toEqual([
      ["resolved", "compraz", "Compras"],
    ]);
    // Short everyday words never become a name.
    expect(findCanonicalReferences("agregalo a la casa", ["Casas"])).toEqual([]);
  });
});

describe("aliases reach writes", () => {
  it("a resolved name is applied to a write's text, whole words only", async () => {
    const { ports, tasks } = makePorts();
    const ctx = makeCtx({ aliases: [{ from: "Mielist", to: "Mi ELISE" }] });
    await executeToolCall(ports, ctx, {
      name: "tasks.create",
      args: { title: "mielistas: cargar finanzas en mielist" },
    });
    const t = [...tasks.tasks.values()][0]!;
    expect(t.title).toBe("Mielistas: cargar finanzas en Mi ELISE");
  });
});

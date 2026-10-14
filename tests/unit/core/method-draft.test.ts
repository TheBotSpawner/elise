import { describe, expect, it } from "vitest";

import type { AIProvider, AITurnRequest } from "@/core/agents/ai-provider";
import {
  draftProblems,
  METHOD_DRAFT_SCHEMA,
  overlap,
  parseMethodDraft,
  structureMethod,
} from "@/core/skills/draft";
import { isMethodImportFile } from "@/core/skills/model";

/** The detailed planning Method from the real UI (abridged). */
const PLANNING = `Siempre que Leo quiera planificar su dia vas a seguir los siguientes pasos.

Paso 1 - Vas a consultar los eventos de sus calendarios de toda la semana, y vas a informarlos. Comentale los de toda la semana, no solo de mañana.

Paso 2 - Una vez Leo te informe sobre las tareas que quiere realizar mañana, vas a armar una planificación en bloques de su día. También dale recomendaciones personalizadas (Ej. llevar su tarjeta SUBE si tiene que salir).

- Tratá de ser lo más eficiente posible con los tiempos.
- Dejá colchones de 5-10 minutos por bloque para no sobrecargarlos.
- Que haya tiempos de descanso también.`;

const GOOD = {
  name: "Planificación diaria contextual",
  capability:
    "Organizar el día de Leo considerando su semana, sus tareas, sus tiempos y lo que necesita llevar.",
  instructions: `1. Revisá los eventos de todos los calendarios de la semana e informalos, no solo los de mañana.
2. Pedile a Leo las tareas que quiere hacer mañana.
3. Armá la planificación del día en bloques y sumá recomendaciones personalizadas (por ejemplo, llevar la SUBE si tiene que salir).

## Reglas
- Usá los tiempos de la forma más eficiente posible.
- Dejá colchones de 5-10 minutos entre bloques.
- Incluí tiempos de descanso.`,
  hints: ["planificar mi día", "plan my day"],
};

/** What the old fallback produced: the opening sentence everywhere. */
const COPIED = {
  name: "Siempre que Leo quiera planificar su dia vas a seguir los siguientes pasos",
  capability: "Siempre que Leo quiera planificar su dia vas a seguir los siguientes pasos",
  instructions: PLANNING,
  hints: [],
};

function scripted(outputs: (string | Error)[]) {
  const calls: AITurnRequest[] = [];
  const ai: AIProvider = {
    id: "scripted",
    async *streamTurn(request) {
      calls.push(request);
      const next = outputs.shift();
      if (next instanceof Error) throw next;
      yield { type: "text_delta", delta: next ?? "" };
      yield { type: "completed", model: "test", usage: null };
    },
  } as AIProvider;
  return { ai, calls };
}

describe("Method draft rules", () => {
  it("a well-formed draft has three distinct fields", () => {
    expect(draftProblems(GOOD, PLANNING)).toEqual([]);
  });

  it("flags the copy-paste draft: long name, copied opening, name ≈ capability", () => {
    const problems = draftProblems(COPIED, PLANNING);
    expect(problems.join(" | ")).toMatch(/name is too long/);
    expect(problems.join(" | ")).toMatch(/copies the user's opening words/);
    expect(problems.join(" | ")).toMatch(/name and capability are nearly the same/);
  });

  it("flags a capability that is really the procedure", () => {
    const problems = draftProblems(
      { ...GOOD, capability: GOOD.instructions.slice(0, 200) },
      PLANNING,
    );
    expect(problems.join(" ")).toMatch(/capability/);
    expect(draftProblems({ ...GOOD, capability: "x".repeat(260) }, PLANNING)).toContainEqual(
      expect.stringMatching(/capability is too long/),
    );
  });

  it("compares words, not accents or punctuation", () => {
    expect(overlap("Planificación del día", "planificacion del dia!")).toBe(1);
    expect(overlap("Crear propuesta", "Revisar facturas")).toBe(0);
  });

  it("parses only the expected shape", () => {
    expect(parseMethodDraft({ name: "A.", capability: "b", instructions: "c\n\n\n\nd" })).toEqual({
      name: "A",
      capability: "b",
      instructions: "c\n\nd",
      hints: [],
    });
    expect(parseMethodDraft({ name: "A", capability: "", instructions: "c" })).toBeNull();
    expect(parseMethodDraft("nope")).toBeNull();
  });
});

describe("Armar el método", () => {
  it("asks for structured output and returns three distinct fields", async () => {
    const { ai, calls } = scripted([JSON.stringify(GOOD)]);
    const d = await structureMethod(ai, PLANNING);
    expect(d).toMatchObject({
      structured: true,
      name: "Planificación diaria contextual",
      description: GOOD.capability,
      instructions: GOOD.instructions,
    });
    expect(d.name.split(" ").length).toBeLessThanOrEqual(7);
    expect(d.instructions).toContain("5-10 minutos");
    expect(calls[0]!.output).toEqual({ name: "method_draft", schema: METHOD_DRAFT_SCHEMA });
    // Scope and permissions are never the model's: the schema has no such fields.
    expect(Object.keys(METHOD_DRAFT_SCHEMA.properties)).toEqual([
      "name",
      "capability",
      "instructions",
      "hints",
    ]);
  });

  it("a short messy description still gets a label, a sentence and steps", async () => {
    const short = {
      name: "Responder mails de clientes",
      capability: "Responder mails de clientes con un tono cordial y breve.",
      instructions:
        "1. Leé el mail completo.\n2. Respondé en tono cordial y breve.\n3. Si piden precio, decí que lo confirmás.",
      hints: ["responder mail"],
    };
    const { ai } = scripted([JSON.stringify(short)]);
    const d = await structureMethod(
      ai,
      "eh cuando contestes mails de clientes q sea cordial y corto y si preguntan precio decí q lo confirmo",
    );
    expect(d.structured).toBe(true);
    expect(d.name).not.toBe(d.description);
    expect(d.description).not.toBe(d.instructions);
  });

  it("a copy-paste answer is retried once with the reasons, then accepted when fixed", async () => {
    const { ai, calls } = scripted([JSON.stringify(COPIED), JSON.stringify(GOOD)]);
    const d = await structureMethod(ai, PLANNING);
    expect(d.structured).toBe(true);
    expect(d.name).toBe("Planificación diaria contextual");
    expect(calls).toHaveLength(2);
    expect(calls[1]!.instructions).toMatch(/rejected because: .*name is too long/);
  });

  it("still malformed after the retry: never repeats the text; it goes to Instructions only", async () => {
    const { ai, calls } = scripted([JSON.stringify(COPIED), JSON.stringify(COPIED)]);
    const d = await structureMethod(ai, PLANNING);
    expect(calls).toHaveLength(2);
    expect(d).toMatchObject({
      structured: false,
      failure: "malformed",
      name: "",
      description: "",
      instructions: PLANNING,
    });
  });

  it("unparseable output is retried; a model error falls back safely without retrying", async () => {
    const bad = scripted(["not json", JSON.stringify(GOOD)]);
    expect((await structureMethod(bad.ai, PLANNING)).structured).toBe(true);
    const down = scripted([new Error("provider down")]);
    const d = await structureMethod(down.ai, PLANNING);
    expect(d).toMatchObject({ structured: false, failure: "model_error", name: "" });
    expect(down.calls).toHaveLength(1);
  });
});

describe("Method import files", () => {
  it("accepts .md and .txt text files only", () => {
    expect(isMethodImportFile({ name: "plan.md", type: "", text: "# Plan" })).toBe(true);
    expect(isMethodImportFile({ name: "plan.MD", type: "text/markdown" })).toBe(true);
    expect(isMethodImportFile({ name: "plan.txt", type: "text/plain", text: "1. x" })).toBe(true);
    expect(isMethodImportFile({ name: "plan.pdf", type: "application/pdf" })).toBe(false);
    expect(isMethodImportFile({ name: "plan.docx", type: "" })).toBe(false);
    expect(isMethodImportFile({ name: "plan.markdown", type: "text/markdown" })).toBe(false);
    // A binary renamed to .txt is refused by its type or its content.
    expect(isMethodImportFile({ name: "x.txt", type: "application/octet-stream" })).toBe(false);
    expect(isMethodImportFile({ name: "x.txt", type: "", text: "PK\u0000\u0003" })).toBe(false);
  });
});

import { describe, expect, it } from "vitest";

import { selectTools } from "@/core/agents/tool-selection";
import { searchTerms, subjectTerms } from "@/core/knowledge/live";
import { nextOccurrence, repeatSchema, type Repeat } from "@/core/tasks/recurrence";

/**
 * Evaluation suite (ADR-114/115): how people in Buenos Aires actually ask. The deterministic
 * half of each case is checked here — routing, retrieval terms, and that the rule the model is
 * told to produce gives the right dates. Whether the live model produces that rule is the live
 * evaluation (docs/engineering/36-notion-recurring-widgets.md).
 */

const tool = (name: string) => ({ name }) as never;
const ALL = ["structured.latest", "structured.query", "knowledge.search", "tasks.create"].map(tool);
const groups = (message: string) => selectTools(ALL, { message }).groups;

describe("Notion: finding things and 'the latest'", () => {
  const notion: [string, string[]][] = [
    [
      "¿Buscás en la Knowledge Base ese artículo que tiene eficiencia de tokens?",
      ["eficiencia", "tokens"],
    ],
    ["Buscame el BP de Claude sobre eficiencia de tokens", ["eficiencia", "tokens", "claude"]],
    ["¿Tenés algo en Notion que hable de cómo ahorrar tokens con Claude?", ["ahorrar", "tokens"]],
  ];
  it.each(notion)("%s → the subject words survive", (q, words) => {
    const subject = subjectTerms(searchTerms(q), ["Knowledge Base"]).join(" ");
    for (const w of words) expect(subject).toContain(w);
    expect(subject).not.toMatch(/\b(buscás|buscame|ese|tiene|articulo)\b/);
  });

  it.each([
    "¿Cuál es mi último post publicado?",
    "Mostrame el último posteo que publiqué",
    "¿Qué fue lo último publicado en la base de Contenidos?",
  ])("%s → database tools are at hand", (q) => {
    expect(groups(q)).toContain("structured");
  });
});

describe("Recurring tasks: the rule behind each phrase", () => {
  // [what the user says, the rule ELISE should send, its first date, the next two dates]
  const cases: [string, Partial<Repeat> & Pick<Repeat, "freq">, string, string[]][] = [
    [
      "Sacar la basura todos los lunes",
      { freq: "weekly", days: ["mo"] },
      "2026-10-26",
      ["2026-11-02", "2026-11-09"],
    ],
    [
      "Pagar el alquiler el 10 de cada mes",
      { freq: "monthly", monthDay: 10 },
      "2026-11-10",
      ["2026-12-10", "2027-01-10"],
    ],
    [
      "Regar las plantas cada 3 días",
      { freq: "daily", interval: 3 },
      "2026-10-23",
      ["2026-10-26", "2026-10-29"],
    ],
    [
      "Los días hábiles revisar el mail del laburo",
      { freq: "weekly", days: ["mo", "tu", "we", "th", "fr"] },
      "2026-10-23",
      ["2026-10-26", "2026-10-27"],
    ],
    [
      "El último viernes de cada mes facturar",
      { freq: "monthly", ordinal: { n: -1, day: "fr" } },
      "2026-10-30",
      ["2026-11-27", "2026-12-25"],
    ],
    [
      "Cortar el pasto cada 15 días",
      { freq: "daily", interval: 15 },
      "2026-10-24",
      ["2026-11-08", "2026-11-23"],
    ],
    [
      "Renovar el seguro del auto todos los años",
      { freq: "yearly" },
      "2027-03-03",
      ["2028-03-03", "2029-03-03"],
    ],
    [
      "Gym martes y jueves, 10 veces",
      { freq: "weekly", days: ["tu", "th"], count: 10 },
      "2026-10-27",
      ["2026-10-29", "2026-11-03"],
    ],
    [
      "Reunión de consorcio el segundo martes de cada mes",
      { freq: "monthly", ordinal: { n: 2, day: "tu" } },
      "2026-11-10",
      ["2026-12-08", "2027-01-12"],
    ],
    [
      "Tomar el antibiótico todos los días hasta el 28",
      { freq: "daily", until: "2026-10-28" },
      "2026-10-26",
      ["2026-10-27", "2026-10-28"],
    ],
    [
      "Limpiar la heladera cada dos semanas, los sábados",
      { freq: "weekly", interval: 2, days: ["sa"] },
      "2026-10-24",
      ["2026-11-07", "2026-11-21"],
    ],
  ];

  it.each(cases)("%s", (q, raw, first, next) => {
    const rule = repeatSchema.parse(raw);
    const dates = [first];
    while (dates.length <= next.length) dates.push(nextOccurrence(rule, first, dates.at(-1)!)!);
    expect(dates.slice(1)).toEqual(next);
    // Tasks are always at hand: "todos los lunes…" never needs a keyword to reach them.
    expect(groups(q)).toContain("tasks");
  });

  it("the series ends where the user said", () => {
    const rule = repeatSchema.parse({ freq: "daily", until: "2026-10-28" });
    expect(nextOccurrence(rule, "2026-10-26", "2026-10-28")).toBeNull();
  });
});

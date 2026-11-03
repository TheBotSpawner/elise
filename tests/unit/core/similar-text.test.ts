import { describe, expect, it } from "vitest";

import { matchItems, type NativeList } from "@/core/capabilities/lists";
import { matchesTaskSearch, matchTaskLists, type Task } from "@/core/capabilities/tasks";
import { mostSimilar, similarText, textSimilarity } from "@/core/lexicon";

const task = (title: string) => ({ title, provenance: {} }) as unknown as Task;

describe("finding what someone remembers (ADR-132)", () => {
  it("the owner's case: other words in between, a plural, accents", () => {
    const title = "Sacar Turno para los estudios medicos";
    expect(similarText("sacar turnos estudios médicos", title)).toBe(true);
    expect(matchesTaskSearch(task(title), "sacar turnos estudios médicos")).toBe(true);
  });

  it("any order, typos and mishearings", () => {
    expect(similarText("estudios turno", "Sacar turno para los estudios")).toBe(true);
    expect(similarText("ecocardiogrma", "Hacerme ecocardiograma")).toBe(true);
    expect(similarText("vencimiento bitibe", "Vencimiento VTV")).toBe(false);
    expect(similarText("basura", "Sacar la bazura")).toBe(true);
  });

  it("a long request may miss one word in four, never more", () => {
    const title = "Sacar turno para los estudios medicos";
    expect(similarText("sacar turno estudios cardiologicos urgentes", title)).toBe(false);
    expect(similarText("sacar turno estudios medicos urgentes", title)).toBe(true);
  });

  it("doesn't confuse what is different", () => {
    expect(similarText("comprar leche", "Comprar pan")).toBe(false);
    expect(similarText("TP 3", "TP 4")).toBe(false);
    expect(similarText("pan", "Panadería")).toBe(false);
    expect(similarText("", "algo")).toBe(false);
    expect(similarText("la", "Sacar la basura")).toBe(true); // only glue: its words count
  });

  it("the closest wins; a tie stays a tie, so ELISE asks", () => {
    const items = ["Pagar la luz", "Pagar el gas", "Llamar al médico"];
    expect(mostSimilar(items, "pagar luz", (s) => s)).toEqual(["Pagar la luz"]);
    expect(mostSimilar(items, "pagar", (s) => s)).toEqual(["Pagar la luz", "Pagar el gas"]);
    expect(mostSimilar(items, "sacar turno", (s) => s)).toEqual([]);
  });

  it("scores the share of words found", () => {
    expect(textSimilarity("pagar luz", "Pagar la luz")).toBe(1);
    expect(textSimilarity("pagar gas", "Pagar la luz")).toBe(0.5);
  });

  it("exact and partial names still win over a resemblance", () => {
    const lists = [
      { id: "1", name: "Compras" },
      { id: "2", name: "Compra del mes" },
    ];
    expect(matchTaskLists(lists, "compras")).toEqual([lists[0]]);
    expect(matchTaskLists([{ id: "3", name: "Lista de compras" }], "listas compra")).toHaveLength(
      1,
    );
    const list = {
      items: [
        { id: "a", content: "Leche descremada" },
        { id: "b", content: "Pan lactal" },
      ],
    } as unknown as NativeList;
    expect(matchItems(list, "Leche descremada").map((i) => i.id)).toEqual(["a"]);
    expect(matchItems(list, "lactal pan").map((i) => i.id)).toEqual(["b"]);
  });
});

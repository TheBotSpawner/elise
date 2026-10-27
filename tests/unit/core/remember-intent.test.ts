import { describe, expect, it } from "vitest";

import { wantsToRemember } from "@/core/agents/tool-selection";

describe("remember vs. remind", () => {
  it("'remember that…' is a fact for Memory", () => {
    for (const m of [
      "Elis, recordá que Cande es muy linda.",
      "acordate que trabajo de 9 a 18",
      "Acordate de que mi socia se llama Ana",
      "tené en cuenta que no como carne",
      "no te olvides que el lunes es feriado para mí",
      "remember that I prefer short answers",
    ])
      expect(wantsToRemember(m), m).toBe(true);
  });

  it("'remind me…' is a task, never Memory", () => {
    for (const m of [
      "Recordame llamar al banco mañana a las 10.",
      "recordame que mañana pague la luz",
      "acordame de comprar pan",
      "avisame cuando termine",
      "¿te acordás de lo que hablamos ayer?",
    ])
      expect(wantsToRemember(m), m).toBe(false);
  });
});

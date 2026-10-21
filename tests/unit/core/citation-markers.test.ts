import { describe, expect, it } from "vitest";

import { CitationMarkerFilter, stripCitationMarkers } from "@/core/agents/citation-markers";
import { toSpeakable } from "@/core/voice/speech-text";

const MARK = "\uE200cite\uE202turn0search0\uE201";

describe("hosted-tool citation markers", () => {
  it("are removed from finished text, screen and voice alike", () => {
    const text = `Es el texto de la fuente oficial. ${MARK}`;
    expect(stripCitationMarkers(text)).toBe("Es el texto de la fuente oficial. ");
    expect(toSpeakable(text)).toBe("Es el texto de la fuente oficial.");
    expect(stripCitationMarkers("Sin marcas.")).toBe("Sin marcas.");
  });

  it("are removed from a stream even when split across deltas", () => {
    const f = new CitationMarkerFilter();
    const out = [
      "Dice: “sostiene el culto”. ",
      "\uE200ci",
      "te\uE202turn0",
      "search0\uE201",
      " Fin.",
    ]
      .map((d) => f.push(d))
      .join("");
    expect(out + f.flush()).toBe("Dice: “sostiene el culto”.  Fin.");
  });

  it("an unclosed marker never swallows the rest of the answer", () => {
    const f = new CitationMarkerFilter();
    const out = f.push(`Hola \uE200${"x".repeat(300)}`) + f.flush();
    expect(out).toBe(`Hola ${"x".repeat(300)}`);
  });
});

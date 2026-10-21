import { describe, expect, it } from "vitest";

import { RECOGNITION_CONTEXT_CHARS, recognitionContext } from "@/core/voice/recognition";
import { acknowledgements } from "@/core/voice/speech-plan";

/** ADR-104: recognition hints in the user's variant, with their own names — never instructions. */
describe("recognitionContext", () => {
  const base = {
    displayName: "Leo",
    brandTerms: ["ELISE", "Mi ELISE"],
    userTerms: ["Análisis de Sistemas", "UTN", "Mercado Pago", "utn"],
  };

  it("an Argentine user gets a Rioplatense hint and their own names, once each", () => {
    const c = recognitionContext({ ...base, locale: "es", country: "AR" });
    expect(c).toMatch(/^Español rioplatense de Argentina, con voseo/);
    expect(c).toContain("Speaker: Leo.");
    expect(c).toContain("Names: ELISE, Mi ELISE, Análisis de Sistemas, UTN, Mercado Pago.");
  });

  it("never forces Argentina on other Spanish speakers, nor Spanish on English ones", () => {
    expect(recognitionContext({ ...base, locale: "es", country: "ES" })).toMatch(/^Español\. /);
    expect(recognitionContext({ ...base, locale: "en", country: "AR" })).toMatch(/^Speaker: Leo/);
  });

  it("stays short, however many names there are", () => {
    const many = Array.from({ length: 200 }, (_, i) => `Cliente número ${i}`);
    const c = recognitionContext({ ...base, userTerms: many, locale: "es", country: "AR" });
    expect(c.length).toBeLessThanOrEqual(RECOGNITION_CONTEXT_CHARS);
  });
});

describe("Rioplatense fixed lines (ADR-104)", () => {
  it("no English “Okay” and no peninsular “Déjame” in Spanish", () => {
    for (const line of acknowledgements("es")) {
      expect(line).not.toMatch(/\bok(ay)?\b/i);
      expect(line).not.toMatch(/Déjame/);
    }
  });
});

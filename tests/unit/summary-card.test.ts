import { describe, expect, it } from "vitest";

import { parseItem } from "@/features/workspace/canvas/summary-card";

/** Summary points: a bold title, clean text, and sources as chips (never inline clutter). */
describe("summary items", () => {
  it("'Title: text [site](url)' → title, text and a source chip", () => {
    expect(
      parseItem(
        "International Association of Forensic Sciences: asociación profesional de ciencias forenses, creada en 1957. [EBSCO](https://www.ebsco.com/x)",
      ),
    ).toEqual({
      title: "International Association of Forensic Sciences",
      text: "asociación profesional de ciencias forenses, creada en 1957.",
      links: [{ label: "EBSCO", url: "https://www.ebsco.com/x" }],
    });
  });

  it("a bracketed URL becomes a chip named by its site; **bold** titles work too", () => {
    expect(parseItem("**Director**: Juan Pérez, con 20 años. [https://example.org/about]")).toEqual(
      {
        title: "Director",
        text: "Juan Pérez, con 20 años.",
        links: [{ label: "example.org", url: "https://example.org/about" }],
      },
    );
  });

  it("the model's own numbering is dropped: the card numbers its points itself", () => {
    expect(parseItem("1. Salpimentá las presas y sellalas en aceite de oliva.").text).toBe(
      "Salpimentá las presas y sellalas en aceite de oliva.",
    );
    expect(parseItem("Paso 2: Sumá la cebolla de verdeo y el ajo.").text).toBe(
      "Sumá la cebolla de verdeo y el ajo.",
    );
    expect(parseItem("3) Agregá vino y dejalo reducir.").text).toBe(
      "Agregá vino y dejalo reducir.",
    );
    // A year or an amount at the start is content, not numbering.
    expect(parseItem("2015 fue el año de su fundación.").text).toBe(
      "2015 fue el año de su fundación.",
    );
  });

  it("plain text stays plain; unsafe links are dropped", () => {
    expect(parseItem("Sin título acá. [x](javascript:alert(1))").title).toBeNull();
    expect(parseItem("Sin título acá. [x](javascript:alert(1))").links).toEqual([]);
  });
});

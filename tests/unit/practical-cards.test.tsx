// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { GuideCard, RecipeCard } from "@/features/workspace/canvas/practical-cards";
import { I18nProvider } from "@/lib/i18n/client";

const es = (node: React.ReactNode) => render(<I18nProvider locale="es">{node}</I18nProvider>);

describe("recipe and step-by-step cards", () => {
  it("a recipe shows its times, ingredients to tick and numbered steps", () => {
    es(
      <RecipeCard
        title="Pasta cremosa de champiñones"
        p={{
          sections: [],
          lead: "Cena rápida para 2.",
          tags: [{ label: "Vegetariana", icon: "leaf" }],
          recipe: {
            prep: "10 min",
            cook: "15 min",
            total: "25 min",
            servings: "2 porciones",
            difficulty: "Fácil",
            ingredients: ["200 g pasta", "200 ml crema"],
            steps: ["Herví la pasta.", "Sumá la crema."],
            tip: "reservá agua de cocción.",
          },
        }}
      />,
    );
    expect(screen.getByRole("heading", { name: "Pasta cremosa de champiñones" })).toBeTruthy();
    expect(screen.getByText("Cocción")).toBeTruthy();
    expect(screen.getByText("Vegetariana")).toBeTruthy();
    expect(screen.getByText("Tip ELISE:")).toBeTruthy();
    const pasta = screen.getByRole("checkbox", { name: "200 g pasta" });
    fireEvent.click(pasta);
    expect(pasta.getAttribute("aria-checked")).toBe("true");
    expect(screen.getAllByRole("listitem").some((li) => li.textContent === "2Sumá la crema.")).toBe(
      true,
    );
  });

  it("a guide counts its steps, ticks materials and shows the progress as steps are done", () => {
    es(
      <GuideCard
        title="Cómo armar un escritorio"
        p={{
          sections: [],
          guide: {
            icon: "wrench",
            duration: "25 min",
            difficulty: "Dificultad baja",
            materials: ["Tablero", "Tornillos"],
            steps: [
              { title: "Prepará las piezas", text: "Separá tornillos." },
              { title: "Fijá la estructura" },
            ],
            tip: "armalo donde va a quedar.",
          },
        }}
      />,
    );
    expect(screen.getByText("2 pasos")).toBeTruthy();
    expect(screen.getByText("2 materiales")).toBeTruthy();
    expect(screen.getByText("0 de 2 completados")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("checkbox", { name: 'Marcar "Prepará las piezas" como hecho' }),
    );
    expect(screen.getByText("1 de 2 completados")).toBeTruthy();
    const materials = screen.getByText("Materiales").closest("section")!;
    fireEvent.click(within(materials).getByRole("checkbox", { name: "Tablero" }));
    expect(
      within(materials).getByRole("checkbox", { name: "Tablero" }).getAttribute("aria-checked"),
    ).toBe("true");
  });
});

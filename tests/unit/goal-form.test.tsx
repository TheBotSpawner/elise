// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { MY_ELISE_ICONS, myEliseItems } from "@/components/elise/navigation/nav-items";
import { NATIVE_MODULES } from "@/core/modules/registry";
import { GoalDialog } from "@/features/native/goal-form";
import { I18nProvider } from "@/lib/i18n/client";

/**
 * The goal form (ADR-057): the period is two dates (shortcuts only fill them) with its
 * duration shown, and every optional field can be removed again before saving — nothing hidden
 * is sent.
 */

const act = vi.fn();
vi.mock("@/features/native/use-native", () => ({ useNative: () => ({ act, pending: false }) }));

beforeAll(() => {
  // jsdom has <dialog> without showModal/close.
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
});
beforeEach(() => act.mockReset());

const options = {
  visions: [{ id: "v1", title: "Firbot Solutions rentable", icon: "🚀" }],
  habits: [{ id: "h1", name: "Workout", icon: "🏋️" }],
  goals: [{ id: "g9", title: "Conseguir 12 clientes", icon: "🤝" }],
  areas: ["Salud"],
};

function open() {
  render(
    <I18nProvider locale="es">
      <GoalDialog open onClose={() => {}} today="2026-10-14" options={options} />
    </I18nProvider>,
  );
  return screen.getByRole("dialog");
}

const lastArgs = () => act.mock.calls.at(-1)![1] as Record<string, unknown>;

describe("goal form", () => {
  it("stores the period as two dates and shows its real duration", () => {
    const d = open();
    fireEvent.change(within(d).getByLabelText("Nombre"), {
      target: { value: "Conseguir 12 clientes" },
    });
    fireEvent.change(within(d).getByLabelText("Meta"), { target: { value: "12" } });
    fireEvent.change(within(d).getByLabelText("Desde"), { target: { value: "2026-10-14" } });
    fireEvent.change(within(d).getByLabelText("Hasta"), { target: { value: "2027-01-13" } });
    expect(within(d).getByText("3 meses")).toBeTruthy();
    fireEvent.change(within(d).getByLabelText("Hasta"), { target: { value: "2026-11-27" } });
    expect(within(d).getByText("44 días")).toBeTruthy();
    fireEvent.click(within(d).getByRole("button", { name: "Crear objetivo" }));
    expect(act).toHaveBeenCalledWith("goals.create", expect.anything(), expect.anything());
    expect(lastArgs()).toMatchObject({ from: "2026-10-14", to: "2026-11-27" });
    // No preset, no invented deadline.
    expect(lastArgs()).not.toHaveProperty("period");
    expect(lastArgs()).not.toHaveProperty("targetDate");
  });

  it("a shortcut only fills the dates, which stay editable", () => {
    const d = open();
    fireEvent.change(within(d).getByLabelText("Nombre"), {
      target: { value: "Publicar artículos" },
    });
    fireEvent.change(within(d).getByLabelText("Meta"), { target: { value: "8" } });
    fireEvent.change(within(d).getByLabelText("Atajos"), { target: { value: "next_quarter" } });
    expect((within(d).getByLabelText("Desde") as HTMLInputElement).value).toBe("2027-01-01");
    expect((within(d).getByLabelText("Hasta") as HTMLInputElement).value).toBe("2027-03-31");
    fireEvent.change(within(d).getByLabelText("Hasta"), { target: { value: "2027-03-15" } });
    fireEvent.click(within(d).getByRole("button", { name: "Crear objetivo" }));
    expect(lastArgs()).toMatchObject({ from: "2027-01-01", to: "2027-03-15" });
  });

  it("optional fields can be removed again, and nothing removed is sent", () => {
    const d = open();
    fireEvent.change(within(d).getByLabelText("Nombre"), { target: { value: "Entrenar" } });
    fireEvent.change(within(d).getByLabelText("Meta"), { target: { value: "36" } });
    for (const [add, remove] of [
      ["Hábitos", "Quitar Hábitos relacionados"],
      ["Descripción", "Quitar Descripción"],
      ["Área", "Quitar Área"],
      ["Contribuye a", "Quitar Contribuye a"],
      ["Fecha límite", "Quitar Fecha límite"],
    ] as const) {
      fireEvent.click(within(d).getByRole("button", { name: add }));
      expect(within(d).getByRole("button", { name: remove })).toBeTruthy();
    }
    fireEvent.change(within(d).getByLabelText("Descripción"), { target: { value: "Texto" } });
    fireEvent.change(within(d).getByLabelText("Área"), { target: { value: "Salud" } });
    fireEvent.change(within(d).getByLabelText("Fecha límite"), { target: { value: "2026-12-20" } });
    for (const remove of [
      "Quitar Hábitos relacionados",
      "Quitar Descripción",
      "Quitar Área",
      "Quitar Contribuye a",
      "Quitar Fecha límite",
    ])
      fireEvent.click(within(d).getByRole("button", { name: remove }));
    // Back to "+ field" chips.
    expect(within(d).getByRole("button", { name: "Descripción" })).toBeTruthy();
    fireEvent.click(within(d).getByRole("button", { name: "Crear objetivo" }));
    const args = lastArgs();
    for (const key of ["habits", "description", "area", "parentGoal", "targetDate"])
      expect(args).not.toHaveProperty(key);
  });

  it("Vision is a primary field when Visions exist", () => {
    const d = open();
    expect(within(d).getByPlaceholderText("Agregar visión…")).toBeTruthy();
  });
});

describe("My Elise icons", () => {
  it("one mapping feeds the menu and the page headers", () => {
    for (const item of myEliseItems(NATIVE_MODULES.map((m) => m.key)))
      expect(item.icon).toBe(MY_ELISE_ICONS[item.key]);
    expect(Object.keys(MY_ELISE_ICONS)).toEqual(
      expect.arrayContaining(["tasks", "habits", "goals", "lists", "notes", "finance"]),
    );
  });
});

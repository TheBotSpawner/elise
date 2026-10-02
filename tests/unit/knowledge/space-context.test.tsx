// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SpaceContext } from "@/features/knowledge/space-context";
import { I18nProvider } from "@/lib/i18n/client";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/features/knowledge/actions", () => ({
  updateSpaceContextAction: vi.fn(async () => ({ ok: true, value: null })),
}));

const view = (initial: string | null) =>
  render(
    <I18nProvider locale="es">
      <SpaceContext spaceId="s1" initial={initial} isSection />
    </I18nProvider>,
  );

describe("Section context", () => {
  it("is one compact line when it exists, and an editor only while editing", () => {
    view("Análisis Matemático II");
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByText("Análisis Matemático II")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Editar contexto" }));
    expect(screen.getByRole("textbox")).toHaveValue("Análisis Matemático II");
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("asks before discarding unsaved changes", () => {
    view("Análisis Matemático II");
    fireEvent.click(screen.getByRole("button", { name: "Editar contexto" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Otra cosa" } });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(confirm).toHaveBeenCalled();
    expect(screen.getByRole("textbox")).toHaveValue("Otra cosa");
  });

  it("empty: a short prompt, no permanent textarea", () => {
    view(null);
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByText("Ayudá a ELISE a entender esta sección.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Agregar contexto/ }));
    expect(screen.getByRole("textbox")).toBeInTheDocument();
  });
});

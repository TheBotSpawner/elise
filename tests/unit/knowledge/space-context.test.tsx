// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ConfirmProvider } from "@/components/ui/confirm";
import { SpaceContext } from "@/features/knowledge/space-context";
import { I18nProvider } from "@/lib/i18n/client";

// jsdom's <dialog> lacks showModal/close.
HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
  this.open = true;
};
HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
  this.open = false;
};

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/features/knowledge/actions", () => ({
  updateSpaceContextAction: vi.fn(async () => ({ ok: true, value: null })),
}));

const view = (initial: string | null) =>
  render(
    <I18nProvider locale="es">
      <ConfirmProvider>
        <SpaceContext spaceId="s1" initial={initial} isSection />
      </ConfirmProvider>
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

  it("asks before discarding unsaved changes (ELISE's dialog, never the native one)", async () => {
    view("Análisis Matemático II");
    fireEvent.click(screen.getByRole("button", { name: "Editar contexto" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Otra cosa" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    const dialog = await screen.findByRole("dialog", {
      name: "¿Descartar los cambios sin guardar?",
    });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Cancelar" }));
    });
    expect(screen.getByRole("textbox")).toHaveValue("Otra cosa");
  });

  it("empty: a short prompt, no permanent textarea", () => {
    view(null);
    expect(screen.queryByRole("textbox")).toBeNull();
    // The explanation is behind ⓘ now; the action stays visible.
    expect(screen.queryByText("Ayudá a ELISE a entender esta sección.")).toBeNull();
    expect(screen.getByRole("button", { name: "Acerca del contexto" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Agregar contexto/ }));
    expect(screen.getByRole("textbox")).toBeInTheDocument();
  });
});

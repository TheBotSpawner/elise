// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { NoteTag } from "@/core/capabilities/notes";
import { I18nProvider } from "@/lib/i18n/client";

/**
 * Note tags on screen (ADR-088): each note's ⋯ menu offers Editar · Etiquetas · Eliminar, and
 * the tag picker checks existing tags or creates one from what was typed.
 */
const calls = vi.hoisted(() => ({ action: vi.fn(async () => ({ ok: true, value: null })) }));
vi.mock("@/features/native/actions", () => ({ nativeActionAction: calls.action }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

const { NoteMenu } = await import("@/features/native/note-tags");

const tags: NoteTag[] = [
  { id: "t1", name: "Ideas", color: "blue" },
  { id: "t2", name: "Urgente", color: "red" },
];
const wrap = (ui: React.ReactNode) => render(<I18nProvider locale="es">{ui}</I18nProvider>);

describe("note ⋯ menu", () => {
  it("Editar · Etiquetas · Eliminar; tags are checked and created from the picker", async () => {
    const onEdit = vi.fn();
    wrap(
      <NoteMenu note={{ id: "n1", title: "Plan", tags: [tags[0]!] }} tags={tags} onEdit={onEdit} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Opciones de Plan" }));
    expect(screen.getAllByRole("menuitem").map((m) => m.textContent)).toEqual([
      "Editar",
      "Etiquetas",
      "Eliminar",
    ]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Editar" }));
    expect(onEdit).toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Opciones de Plan" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Etiquetas" }));
    const ideas = screen.getByRole("menuitemcheckbox", { name: /Ideas/ });
    expect(ideas.getAttribute("aria-checked")).toBe("true");
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitemcheckbox", { name: /Urgente/ }));
    });
    expect(calls.action).toHaveBeenLastCalledWith("notes.tag", {
      note: "n1",
      tags: ["Ideas", "Urgente"],
    });
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Cocina" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Crear «Cocina»" }));
    });
    expect(calls.action).toHaveBeenLastCalledWith("notes.tag", { note: "n1", add: ["Cocina"] });
  });
});

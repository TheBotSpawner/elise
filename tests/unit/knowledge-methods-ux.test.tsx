// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { InfoTip } from "@/components/shared/info-tip";
import type { SpaceRef } from "@/core/skills/model";
import { SpaceContext } from "@/features/knowledge/space-context";
import { MethodsPanel } from "@/features/methods/methods-panel";
import { I18nProvider } from "@/lib/i18n/client";
import { es } from "@/lib/i18n/dictionaries/es";

const toast = vi.hoisted(() => Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));
const actions = vi.hoisted(() => ({
  importMethodAction: vi.fn(async () => ({ ok: true, value: { id: "m1" } })),
  methodDetailAction: vi.fn(async () => ({ ok: false, error: { code: "NOT_FOUND" } })),
  draftMethodAction: vi.fn(),
  createMethodAction: vi.fn(),
}));
vi.mock("@/features/methods/actions", () => ({
  ...actions,
  addFileReferenceAction: vi.fn(),
  addTextReferenceAction: vi.fn(),
  exportMethodAction: vi.fn(),
  removeReferenceAction: vi.fn(),
  rollbackMethodAction: vi.fn(),
  setMethodStatusAction: vi.fn(),
  updateMethodAction: vi.fn(),
}));
vi.mock("@/features/knowledge/actions", () => ({ updateSpaceContextAction: vi.fn() }));

// jsdom has no <dialog> methods.
beforeEach(() => {
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.removeAttribute("open");
  };
  vi.clearAllMocks();
});

const GENERAL: SpaceRef = {
  id: "g",
  name: "General",
  parentId: null,
  path: "General",
  general: true,
};
const FIRBOT: SpaceRef = {
  id: "f",
  name: "Firbot Marketing",
  parentId: null,
  path: "Firbot Marketing",
};
const SECTION: SpaceRef = {
  id: "s",
  name: "Redes",
  parentId: "f",
  path: "Firbot Marketing › Redes",
};
const SPACES = [GENERAL, FIRBOT, SECTION];

function panel(space: SpaceRef) {
  return render(
    <I18nProvider locale="es">
      <MethodsPanel methods={[]} spaces={SPACES} space={space} />
    </I18nProvider>,
  );
}

const tm = es.methods;

describe("InfoTip", () => {
  it("opens on click/tap, closes with Esc (focus back) and with a click outside", () => {
    render(<InfoTip label="Acerca de los Métodos" body={["Texto de ayuda."]} />);
    const button = screen.getByRole("button", { name: "Acerca de los Métodos" });
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.click(button);
    expect(screen.getByRole("tooltip").textContent).toContain("Texto de ayuda.");
    expect(button.getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(document.activeElement).toBe(button);

    fireEvent.click(button);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("is a focusable button: keyboard Enter/Space work through click", () => {
    render(<InfoTip label="Acerca" body={["x"]} />);
    const button = screen.getByRole("button", { name: "Acerca" });
    button.focus();
    expect(document.activeElement).toBe(button);
    expect(button.tagName).toBe("BUTTON");
  });
});

describe("Methods in Knowledge", () => {
  it("General: hierarchy and examples behind ⓘ; a short empty state", () => {
    panel(GENERAL);
    expect(screen.queryByText(tm.generalHint)).toBeNull();
    expect(screen.getByText("Todavía no hay métodos.")).toBeTruthy();
    expect(screen.queryByText(/Por ejemplo/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Acerca de los Métodos" }));
    const tip = screen.getByRole("tooltip");
    expect(tip.textContent).toContain(tm.infoGeneral);
    expect(tip.textContent).toContain("Cuando planifiques mi día");
  });

  it("a Space explains its own precedence; actions are Nuevo método and Importar método", () => {
    panel(FIRBOT);
    fireEvent.click(screen.getByRole("button", { name: "Acerca de los Métodos" }));
    expect(screen.getByRole("tooltip").textContent).toContain(tm.infoSpace);
    expect(screen.getByRole("button", { name: /Nuevo método/ })).toBeTruthy();
    const importButton = screen.getByRole("button", { name: /Importar método/ });
    expect(importButton.getAttribute("title")).toBe(
      "Importá un Método desde un archivo .md o .txt.",
    );
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    expect(input.accept).toBe(".md,.txt");
  });

  it.each([
    [GENERAL, "Se guardará en General."],
    [FIRBOT, "Se guardará en Firbot Marketing."],
    [SECTION, "Se guardará en Firbot Marketing › Redes."],
  ])(
    "a new Method is saved where it was opened (%s.name), with no scope selector",
    (space, hint) => {
      panel(space);
      fireEvent.click(screen.getByRole("button", { name: /Nuevo método/ }));
      expect(screen.getByText(hint)).toBeTruthy();
      expect(screen.queryByLabelText("Dónde aplica")).toBeNull();
      expect(screen.queryByText("Dónde aplica")).toBeNull();
    },
  );

  it("imports .md and .txt; refuses other files with a clear message", async () => {
    panel(FIRBOT);
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    const pick = async (file: File) =>
      act(async () => {
        fireEvent.change(input, { target: { files: [file] } });
      });
    await pick(new File(["%PDF-1.7"], "plan.pdf", { type: "application/pdf" }));
    expect(toast.error).toHaveBeenCalledWith(tm.importFormats);
    expect(actions.importMethodAction).not.toHaveBeenCalled();

    await pick(new File(["# Plan\n1. Paso"], "plan.md", { type: "" }));
    await pick(new File(["1. Paso"], "plan.txt", { type: "text/plain" }));
    expect(actions.importMethodAction).toHaveBeenCalledTimes(2);
    expect(actions.importMethodAction).toHaveBeenCalledWith("# Plan\n1. Paso", "plan.md", "f");
  });

  it("an unstructured draft fills only Instructions and says so", async () => {
    actions.draftMethodAction.mockResolvedValueOnce({
      ok: true,
      value: { name: "", description: "", instructions: "Mi texto", hints: [], structured: false },
    });
    panel(GENERAL);
    fireEvent.click(screen.getByRole("button", { name: /Nuevo método/ }));
    fireEvent.change(screen.getByLabelText(tm.tell), {
      target: { value: "Mi texto largo de prueba" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: tm.tellAction }));
    });
    expect((screen.getByLabelText(tm.name) as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText(tm.instructions) as HTMLTextAreaElement).value).toBe("Mi texto");
    expect(toast).toHaveBeenCalledWith(tm.draftUnstructured);
  });
});

describe("Context", () => {
  it("keeps CONTEXTO and Agregar contexto visible; the explanation is behind ⓘ", () => {
    render(
      <I18nProvider locale="es">
        <SpaceContext spaceId="f" initial={null} isSection={false} />
      </I18nProvider>,
    );
    expect(screen.getByText("Contexto")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Agregar contexto/ })).toBeTruthy();
    expect(screen.queryByText(es.knowledge.context.emptySpace)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Acerca del contexto" }));
    expect(screen.getByRole("tooltip").textContent).toContain(es.knowledge.context.infoSpace);
  });
});

describe("Knowledge copy", () => {
  it("uses Agregar fuente / Subir documentos, never Sumar, in Knowledge", () => {
    const k = es.knowledge;
    expect(k.addSource).toBe("Agregar fuente");
    expect(k.options.documents.title).toBe("Subir documentos");
    const knowledgeCopy = JSON.stringify({ ...k, methods: es.methods });
    expect(knowledgeCopy).not.toMatch(/Sumar fuente|Sumar documentos|Sumar conocimiento/);
    expect(tm.empty).toBe("Todavía no hay métodos.");
  });
});

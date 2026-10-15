// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MethodDetail } from "@/application/methods-service";
import { InfoTip } from "@/components/shared/info-tip";
import { PageHeader } from "@/components/shared/page";
import type { SpaceRef } from "@/core/skills/model";
import { MethodsPanel } from "@/features/methods/methods-panel";
import { I18nProvider } from "@/lib/i18n/client";
import { es } from "@/lib/i18n/dictionaries/es";

/**
 * Methods editor (close on save, collapsed supporting material) and ELISE's single contextual
 * help pattern: an anchored card, never a modal over a blurred page.
 */

const toast = vi.hoisted(() => Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
const actions = vi.hoisted(() => ({
  createMethodAction: vi.fn(),
  updateMethodAction: vi.fn(),
  methodDetailAction: vi.fn(),
}));
vi.mock("@/features/methods/actions", () => ({
  ...actions,
  importMethodAction: vi.fn(),
  draftMethodAction: vi.fn(),
  addFileReferenceAction: vi.fn(),
  addTextReferenceAction: vi.fn(),
  exportMethodAction: vi.fn(),
  removeReferenceAction: vi.fn(),
  rollbackMethodAction: vi.fn(),
  setMethodStatusAction: vi.fn(),
}));

beforeEach(() => {
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.removeAttribute("open");
  };
  vi.clearAllMocks();
});

const tm = es.methods;
const FIRBOT: SpaceRef = {
  id: "f",
  name: "Firbot Marketing",
  parentId: null,
  path: "Firbot Marketing",
};

const detail = (references: MethodDetail["references"] = []): MethodDetail => ({
  method: {
    id: "m1",
    name: "Propuestas",
    description: "Cómo armo propuestas",
    instructions: "1. Leer el brief",
    hints: [],
    spaceId: "f",
    platforms: [],
    version: 2,
    updatedAt: "2026-10-14T10:00:00Z",
    status: "active",
    changeSummary: "",
    createdAt: "2026-10-01T10:00:00Z",
  },
  versions: [],
  references,
});

function panel(opened: MethodDetail | null = null) {
  return render(
    <I18nProvider locale="es">
      <MethodsPanel methods={[]} spaces={[FIRBOT]} space={FIRBOT} opened={opened} />
    </I18nProvider>,
  );
}

const openDialog = () => document.querySelector("dialog[open]");
const type = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

function fillNew() {
  fireEvent.click(screen.getByRole("button", { name: tm.new }));
  type(tm.name, "Planificar mi día");
  type(tm.description, "Cómo ordeno el día");
  type(tm.instructions, "Primero lo urgente.");
}

describe("Method editor", () => {
  it("a new Method closes the editor once it is saved, and the cards refresh", async () => {
    actions.createMethodAction.mockResolvedValue({ ok: true, value: { id: "m9" } });
    panel();
    fillNew();
    expect(openDialog()).not.toBeNull();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: tm.save })));
    expect(actions.createMethodAction).toHaveBeenCalledTimes(1);
    expect(openDialog()).toBeNull();
    expect(router.refresh).toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith(tm.saved);
    // It doesn't reopen the Method it just saved.
    expect(actions.methodDetailAction).not.toHaveBeenCalled();
  });

  it("a failed save keeps the editor open with everything typed", async () => {
    actions.createMethodAction.mockResolvedValue({
      ok: false,
      error: { code: "VALIDATION_ERROR", message: "x" },
    });
    panel();
    fillNew();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: tm.save })));
    expect(openDialog()).not.toBeNull();
    expect((screen.getByLabelText(tm.name) as HTMLInputElement).value).toBe("Planificar mi día");
    expect((screen.getByLabelText(tm.instructions) as HTMLTextAreaElement).value).toBe(
      "Primero lo urgente.",
    );
    expect(toast.error).toHaveBeenCalled();
  });

  it("saves once even when Guardar is pressed twice, and shows it is saving", async () => {
    let resolve: (v: unknown) => void = () => undefined;
    actions.createMethodAction.mockReturnValue(new Promise((r) => (resolve = r)));
    panel();
    fillNew();
    const save = screen.getByRole("button", { name: tm.save });
    await act(async () => {
      fireEvent.click(save);
      fireEvent.click(save);
    });
    expect(actions.createMethodAction).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: tm.saving })).toBeDisabled();
    await act(async () => resolve({ ok: true, value: { id: "m9" } }));
    expect(openDialog()).toBeNull();
  });

  it("editing: a successful save closes the editor too", async () => {
    actions.updateMethodAction.mockResolvedValue({ ok: true, value: { version: 3 } });
    panel(detail());
    type(tm.name, "Propuestas v2");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: tm.save })));
    expect(actions.updateMethodAction).toHaveBeenCalledWith(
      "m1",
      expect.objectContaining({ name: "Propuestas v2" }),
      "",
    );
    expect(openDialog()).toBeNull();
    expect(router.refresh).toHaveBeenCalled();
  });

  it("Material de apoyo starts collapsed and opens on demand", () => {
    panel();
    fireEvent.click(screen.getByRole("button", { name: tm.new }));
    const toggle = screen.getByRole("button", { name: tm.material });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    const region = document.getElementById(toggle.getAttribute("aria-controls")!)!;
    expect(region).not.toBeVisible();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(region).toBeVisible();
    expect(screen.getByText(tm.saveFirst)).toBeVisible();
  });

  it("existing material: the count shows, and every item is there when opened", () => {
    panel(
      detail([
        {
          id: "r1",
          kind: "template",
          title: "Plantilla",
          sourceType: "text",
          mimeType: null,
          attachmentId: null,
          knowledgeItemId: null,
          content: "x",
          createdAt: "",
        },
        {
          id: "r2",
          kind: "example",
          title: "Ejemplo bueno",
          sourceType: "text",
          mimeType: null,
          attachmentId: null,
          knowledgeItemId: null,
          content: "y",
          createdAt: "",
        },
      ]),
    );
    const toggle = screen.getByRole("button", { name: /Material de apoyo\s*·\s*2/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(screen.getByText("Ejemplo bueno")).toBeVisible();
    expect(screen.getAllByRole("button", { name: tm.remove })).toHaveLength(2);
  });

  it("a new Method still has no 'Dónde aplica' choice: it belongs where it was created", () => {
    panel();
    fireEvent.click(screen.getByRole("button", { name: tm.new }));
    expect(screen.queryByLabelText(tm.where)).toBeNull();
    expect(screen.getByText(tm.savesIn("Firbot Marketing"))).toBeInTheDocument();
  });
});

describe("Contextual help (InfoTip)", () => {
  it("opens an anchored card — no dialog, no page overlay — and closes outside or with Esc", () => {
    render(
      <InfoTip label="Qué es General" title="General" body={["El espacio predeterminado."]} />,
    );
    const button = screen.getByRole("button", { name: "Qué es General" });
    expect(button).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(button);
    const card = screen.getByRole("tooltip");
    expect(card).toHaveTextContent("General");
    expect(card).toHaveTextContent("El espacio predeterminado.");
    expect(button).toHaveAttribute("aria-controls", card.id);
    expect(document.querySelector("dialog")).toBeNull();
    // Theme tokens, not fixed colors: it follows light and dark mode.
    expect(card.className).toContain("bg-[var(--overlay-bg)]");
    expect(card.className).toContain("border-border-strong");
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.click(button);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(button).toHaveFocus();
  });

  it("stays inside a phone's viewport", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 360 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 640 });
    render(<InfoTip label="Ayuda" body={["Una explicación corta."]} />);
    const button = screen.getByRole("button", { name: "Ayuda" });
    button.getBoundingClientRect = () =>
      ({ left: 340, right: 356, top: 600, bottom: 616, width: 16, height: 16 }) as DOMRect;
    fireEvent.click(button);
    const card = screen.getByRole("tooltip");
    const left = parseFloat(card.style.left);
    const width = parseFloat(card.style.width);
    expect(left).toBeGreaterThanOrEqual(16);
    expect(left + width).toBeLessThanOrEqual(360 - 16);
  });

  it("section headers (Conexiones, Conocimiento…) use it instead of the old centered modal", () => {
    render(
      <I18nProvider locale="es">
        <PageHeader
          title="Conexiones"
          info={["A qué puede acceder ELISE. Vos mantenés el control."]}
        />
      </I18nProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: es.common.aboutSection("Conexiones") }));
    expect(screen.getByRole("tooltip")).toHaveTextContent("Vos mantenés el control.");
    expect(document.querySelector("dialog")).toBeNull();
  });

  it("actions still use real dialogs (Nuevo método is a dialog)", () => {
    panel();
    fireEvent.click(screen.getByRole("button", { name: tm.new }));
    expect(openDialog()).not.toBeNull();
  });
});

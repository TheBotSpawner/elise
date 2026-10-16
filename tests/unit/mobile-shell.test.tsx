// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { BottomNav } from "@/components/elise/navigation/bottom-nav";
import { MyEliseModulesProvider } from "@/components/elise/navigation/modules-context";
import { Dialog } from "@/components/ui/dialog";
import { FilterButton, FilterSheet, OverflowMenu } from "@/components/ui/sheet-menu";
import type { NativeModuleKey } from "@/core/modules/registry";
import { I18nProvider } from "@/lib/i18n/client";

/** Mobile-first system (ADR-066): the phone navigation and the shared sheets. */

const nav = vi.hoisted(() => ({ path: "/" }));
vi.mock("next/navigation", () => ({
  usePathname: () => nav.path,
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/features/auth/actions", () => ({ signOut: vi.fn() }));

/** Phone or desktop, as matchMedia("(min-width: 768px)") answers. */
function viewport(desktop: boolean) {
  window.matchMedia = ((q: string) => ({
    matches: desktop && q.includes("min-width: 768px"),
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
}

beforeAll(() => {
  // jsdom has <dialog> without showModal/close.
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
});
afterEach(() => {
  nav.path = "/";
});

const user = { name: "Leo", initial: "L", email: "leo@example.com" };

function bottomNav(modules: NativeModuleKey[] = ["tasks", "lists"], pending = 0) {
  viewport(false);
  return render(
    <I18nProvider locale="es">
      <MyEliseModulesProvider modules={modules}>
        <BottomNav user={user as never} pendingApprovals={pending} />
      </MyEliseModulesProvider>
    </I18nProvider>,
  );
}

describe("bottom navigation", () => {
  it("five destinations with labels; the current one is marked", () => {
    nav.path = "/knowledge/spaces/x";
    bottomNav();
    const bar = screen.getByRole("navigation");
    const items = within(bar)
      .getAllByRole("listitem")
      .map((li) => li.textContent);
    expect(items).toEqual(["Inicio", "Historial", "Conocimiento", "Mi ELISE", "Más"]);
    expect(within(bar).getByRole("link", { name: "Conocimiento" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("Mi ELISE opens the person's modules only, and where to manage them", () => {
    bottomNav(["tasks", "finance"]);
    fireEvent.click(screen.getByRole("button", { name: "Mi ELISE" }));
    const sheet = screen.getByRole("dialog", { name: "Mi ELISE" });
    expect(within(sheet).getByRole("link", { name: "Tareas" })).toHaveAttribute(
      "href",
      "/my-elise/tasks",
    );
    expect(within(sheet).getByRole("link", { name: "Finanzas" })).toBeInTheDocument();
    expect(within(sheet).queryByRole("link", { name: "Hábitos" })).toBeNull();
    expect(within(sheet).getByRole("link", { name: "Administrar Mi ELISE" })).toHaveAttribute(
      "href",
      "/connections#mi-elise",
    );
  });

  it("Más holds Conexiones, Programados, Aprobaciones and Configuración; pending approvals show a dot", () => {
    nav.path = "/schedules";
    const { container } = bottomNav(["tasks"], 2);
    const more = screen.getByRole("button", { name: "Más" });
    expect(more).toHaveAttribute("aria-current", "page");
    expect(container.querySelector(".bg-approval")).not.toBeNull();
    fireEvent.click(more);
    const sheet = screen.getByRole("dialog", { name: "Más" });
    expect(
      within(sheet)
        .getAllByRole("link")
        .map((l) => l.getAttribute("href")),
    ).toEqual(["/connections", "/schedules", "/approvals", "/settings"]);
  });
});

describe("overflow menu", () => {
  const items = [
    { label: "Eliminar", onClick: vi.fn(), danger: true },
    { label: "Editar", onClick: vi.fn() },
  ];

  it("phones: an action sheet, destructive action last", () => {
    viewport(false);
    render(
      <I18nProvider locale="es">
        <OverflowMenu label="Más acciones" items={items} />
      </I18nProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Más acciones" }));
    const sheet = screen.getByRole("dialog", { name: "Más acciones" });
    expect(
      within(sheet)
        .getAllByRole("menuitem")
        .map((b) => b.textContent),
    ).toEqual(["Editar", "Eliminar"]);
    fireEvent.click(within(sheet).getByRole("menuitem", { name: "Editar" }));
    expect(items[1]!.onClick).toHaveBeenCalled();
  });

  it("desktop: an anchored menu, no sheet", () => {
    viewport(true);
    render(
      <I18nProvider locale="es">
        <OverflowMenu label="Más acciones" items={items} />
      </I18nProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Más acciones" }));
    expect(screen.getByRole("menu", { name: "Más acciones" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("filters", () => {
  it("the trigger says how many are on; the sheet clears and applies", () => {
    const onClear = vi.fn();
    const onClose = vi.fn();
    render(
      <I18nProvider locale="es">
        <FilterButton count={2} onClick={() => {}} />
        <FilterSheet open onClose={onClose} onClear={onClear}>
          <select aria-label="Prioridad" />
        </FilterSheet>
      </I18nProvider>,
    );
    expect(screen.getByRole("button", { name: "Filtros · 2" })).toBeInTheDocument();
    const sheet = screen.getByRole("dialog", { name: "Filtros" });
    expect(within(sheet).getByLabelText("Prioridad")).toBeInTheDocument();
    fireEvent.click(within(sheet).getByRole("button", { name: "Limpiar" }));
    fireEvent.click(within(sheet).getByRole("button", { name: "Aplicar" }));
    expect(onClear).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });
});

describe("form sheets", () => {
  it("phones get Cancelar in the header; the content is marked as a form sheet", () => {
    const onClose = vi.fn();
    render(
      <I18nProvider locale="es">
        <Dialog open onClose={onClose} title="Nueva sección" size="form">
          <form>
            <div data-sheet-actions>
              <button type="submit">Crear</button>
            </div>
          </form>
        </Dialog>
      </I18nProvider>,
    );
    const dialog = screen.getByRole("dialog", { name: "Nueva sección" });
    expect(dialog.querySelector('[data-sheet="form"]')).not.toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancelar" }));
    expect(onClose).toHaveBeenCalled();
  });
});

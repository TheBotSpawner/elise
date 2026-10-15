// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { MyEliseModulesProvider } from "@/components/elise/navigation/modules-context";
import { MyEliseMenu } from "@/components/elise/navigation/top-nav";
import type { NativeModuleKey } from "@/core/modules/registry";
import { I18nProvider } from "@/lib/i18n/client";

/** The Mi ELISE menu shows only the modules a person uses, in order (ADR-064). */

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

function menu(modules: NativeModuleKey[]) {
  return render(
    <I18nProvider locale="es">
      <MyEliseModulesProvider modules={modules}>
        <MyEliseMenu open onOpenChange={() => {}} current={false} />
      </MyEliseModulesProvider>
    </I18nProvider>,
  );
}

describe("Mi ELISE menu", () => {
  it("lists only enabled modules, with their routes, and no Atajos", () => {
    menu(["tasks", "notes"]);
    const links = screen
      .getAllByRole("menuitem")
      .map((l) => [l.textContent, l.getAttribute("href")]);
    expect(links).toEqual([
      ["Tareas", "/my-elise/tasks"],
      ["Notas", "/my-elise/notes"],
      ["Administrar Mi ELISE", "/connections#mi-elise"],
    ]);
    expect(screen.queryByText("Atajos")).toBeNull();
  });

  it("with nothing on, says so calmly and offers to choose", () => {
    menu([]);
    expect(screen.getByText("Todavía no activaste módulos.")).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Elegir módulos" }).getAttribute("href")).toBe(
      "/connections#mi-elise",
    );
  });
});

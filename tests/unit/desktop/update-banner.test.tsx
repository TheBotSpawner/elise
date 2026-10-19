// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { I18nProvider } from "@/lib/i18n/client";

/**
 * Desktop updates (ADR-081): a version downloaded in the background is offered with
 * "Actualizar ahora" (restart into it) or "Más tarde" (until the next version).
 */
const installUpdate = vi.fn(async () => undefined);
(window as unknown as { eliseDesktop: unknown }).eliseDesktop = {
  getUpdateState: async () => ({ status: "ready", version: "0.1.0-beta.3" }),
  onUpdate: () => () => undefined,
  installUpdate,
  checkForUpdates: vi.fn(),
};

const { UpdateRequiredBanner } = await import("../../../desktop/src/renderer/screens");

describe("update bar", () => {
  it("offers a downloaded version; Actualizar ahora restarts into it; Más tarde hides it", async () => {
    const { unmount } = render(
      <I18nProvider locale="es">
        <UpdateRequiredBanner />
      </I18nProvider>,
    );
    expect(
      await screen.findByText(/nueva versión de ELISE Desktop \(0\.1\.0-beta\.3\)/),
    ).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Actualizar ahora" }));
    });
    expect(installUpdate).toHaveBeenCalled();
    expect(screen.getByText(/Actualizando/)).toBeTruthy();
    unmount();

    render(
      <I18nProvider locale="es">
        <UpdateRequiredBanner />
      </I18nProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Más tarde" }));
    expect(screen.queryByText(/nueva versión/)).toBeNull();
  });
});

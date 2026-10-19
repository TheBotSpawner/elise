// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { DeviceDiscovery } from "@/features/home/device-discovery";
import { HomeRuntimeProvider, type HomeRuntimeControls } from "@/features/home/runtime-context";
import { I18nProvider } from "@/lib/i18n/client";

/**
 * Hogar's "Dispositivos" step (ADR-090): it lists what was found, adds what the person picks
 * (a confirmation or a pairing code), lets them skip one, and always lets them continue.
 */
const TV = "01JABCDEFGHJKMNPQRSTVWXYZ0";
const HUE = "01JABCDEFGHJKMNPQRSTVWXYZ1";

function runtime(over: Partial<HomeRuntimeControls> = {}): HomeRuntimeControls {
  return {
    state: null,
    setup: vi.fn(),
    enableRequirements: vi.fn(),
    restartComputer: vi.fn(),
    reset: vi.fn(),
    diagnostics: vi.fn(),
    discoveries: vi.fn(async () => [
      { flowId: HUE, name: "Hue Bridge", kind: "hue" },
      { flowId: TV, name: "Living TV", kind: "cast" },
    ]),
    openDiscovery: vi.fn(async (id: string) =>
      id === TV
        ? { kind: "confirm" as const, flowId: TV, title: "Living TV" }
        : {
            kind: "form" as const,
            flowId: HUE,
            title: null,
            fields: [{ name: "pairing_code", type: "password" as const, required: true }],
            errors: {},
          },
    ),
    answerDiscovery: vi.fn(async (id: string) =>
      id === TV
        ? { kind: "added" as const, name: "Living TV" }
        : { kind: "added" as const, name: "Hue" },
    ),
    ignoreDiscovery: vi.fn(async () => true),
    ...over,
  };
}

const wrap = (value: HomeRuntimeControls | null, onDone = vi.fn()) =>
  render(
    <I18nProvider locale="es">
      {value ? (
        <HomeRuntimeProvider value={value}>
          <DeviceDiscovery onDone={onDone} addedCount={0} />
        </HomeRuntimeProvider>
      ) : (
        <DeviceDiscovery onDone={onDone} addedCount={0} />
      )}
    </I18nProvider>,
  );

describe("devices step", () => {
  it("adds a confirmed device and one with a pairing code; continues afterwards", async () => {
    const r = runtime();
    const onDone = vi.fn();
    wrap(r, onDone);
    expect(
      await screen.findByText(/Encontramos 2 dispositivos/, {}, { timeout: 4000 }),
    ).toBeTruthy();
    const [hueAdd, tvAdd] = screen.getAllByRole("button", { name: "Agregar" });
    // A confirmation…
    await act(async () => fireEvent.click(tvAdd!));
    expect(screen.getByText("¿Agregar Living TV a tu casa?")).toBeTruthy();
    const confirmForm = screen.getByText("¿Agregar Living TV a tu casa?").closest("form")!;
    await act(async () =>
      fireEvent.click(within(confirmForm).getByRole("button", { name: "Agregar" })),
    );
    expect(r.answerDiscovery).toHaveBeenCalledWith(TV, {});
    // …and a pairing code.
    await act(async () => fireEvent.click(hueAdd!));
    const code = screen.getByLabelText("Código de vinculación");
    // Hidden by default; the eye shows what was typed.
    expect(code).toHaveAttribute("type", "password");
    fireEvent.click(screen.getByRole("button", { name: "Mostrar" }));
    expect(code).toHaveAttribute("type", "text");
    fireEvent.change(code, { target: { value: "123-45-678" } });
    await act(async () =>
      fireEvent.click(within(code.closest("form")!).getByRole("button", { name: "Continuar" })),
    );
    expect(r.answerDiscovery).toHaveBeenCalledWith(HUE, { pairing_code: "123-45-678" });
    expect(screen.getAllByText("Agregado")).toHaveLength(2);
    // Footer: Continuar (something was added).
    fireEvent.click(screen.getAllByRole("button", { name: "Continuar" }).at(-1)!);
    expect(onDone).toHaveBeenCalled();
  });

  it("“No, gracias” skips one; with nothing added the person can still skip the step", async () => {
    const r = runtime();
    const onDone = vi.fn();
    wrap(r, onDone);
    await screen.findByText(/Encontramos 2 dispositivos/, {}, { timeout: 4000 });
    await act(async () =>
      fireEvent.click(screen.getAllByRole("button", { name: "No, gracias" })[0]!),
    );
    expect(r.ignoreDiscovery).toHaveBeenCalledWith(HUE, "Hue Bridge");
    expect(screen.getByText(/Encontramos 1 dispositivo/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Omitir por ahora" }));
    expect(onDone).toHaveBeenCalled();
  });

  it("on the web it says to open ELISE Desktop (the engine runs there)", () => {
    wrap(null);
    expect(screen.getByText(/abrí ELISE Desktop/)).toBeTruthy();
  });
});

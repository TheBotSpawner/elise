// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { DiscoveredDevice } from "@/core/home/discovery";
import { describeState, type HomeDevice } from "@/core/home/model";
import * as actions from "@/features/home/actions";
import { DeviceDiscovery } from "@/features/home/device-discovery";
import { RemoteControl } from "@/features/home/remote-control";
import { HomeRuntimeProvider, type HomeRuntimeControls } from "@/features/home/runtime-context";
import { I18nProvider } from "@/lib/i18n/client";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
// ADR-103: adopting what a finished setup brought in is a server action.
vi.mock("@/features/home/actions", () => ({
  adoptNewDevicesAction: vi.fn(async () => ({ ok: true, value: { added: 0 } })),
  updateDeviceAction: vi.fn(async () => ({ ok: true, value: null })),
  // ADR-119: Smart Life is off on this server: its entry doesn't show.
  tuyaStatusAction: vi.fn(async () => ({
    ok: true,
    value: { availability: { state: "off" }, connections: [] },
  })),
  connectTuyaAction: vi.fn(),
  linkTuyaTestAction: vi.fn(async () => ({ ok: true, value: "c1" })),
  tuyaOverviewAction: vi.fn(async () => ({ ok: true, value: { hubs: [], otherDevices: 0 } })),
  tuyaImportAction: vi.fn(),
  tuyaSyncAction: vi.fn(),
  disconnectTuyaAction: vi.fn(),
  controlDeviceAction: vi.fn(),
}));

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
    addBroadlink: vi.fn(async () => ({ kind: "aborted" as const, reason: "invalid_host" })),
    learnIr: vi.fn(async () => ({ ok: true as const })),
    ...over,
  };
}

const wrap = (
  value: HomeRuntimeControls | null,
  onDone = vi.fn(),
  extra: { found?: HomeDevice[]; skippable?: boolean } = {},
) =>
  render(
    <I18nProvider locale="es">
      {value ? (
        <HomeRuntimeProvider value={value}>
          <DeviceDiscovery onDone={onDone} addedCount={0} {...extra} />
        </HomeRuntimeProvider>
      ) : (
        <DeviceDiscovery onDone={onDone} addedCount={0} {...extra} />
      )}
    </I18nProvider>,
  );

/** A device the engine registered some other time (not confirmed by this search). */
const seen = (id: string, name: string) =>
  ({
    id,
    name,
    aliases: [],
    roomId: null,
    type: "media_player",
    capabilities: [],
    state: {},
    available: true,
    stateUpdatedAt: null,
    favorite: false,
  }) as HomeDevice;

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((a) => (resolve = a));
  return { promise, resolve };
}

describe("devices step", () => {
  it("adds a confirmed device and one with a pairing code; continues afterwards", async () => {
    const r = runtime();
    const onDone = vi.fn();
    wrap(r, onDone);
    expect(await screen.findByText(/2 encontrados ahora/, {}, { timeout: 4000 })).toBeTruthy();
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
    await screen.findByText(/2 encontrados ahora/, {}, { timeout: 4000 });
    await act(async () =>
      fireEvent.click(screen.getAllByRole("button", { name: "No, gracias" })[0]!),
    );
    expect(r.ignoreDiscovery).toHaveBeenCalledWith(HUE, "Hue Bridge");
    expect(screen.getByText(/1 encontrado ahora/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Omitir por ahora" }));
    expect(onDone).toHaveBeenCalled();
  });

  it("on the web it says to open ELISE Desktop (the engine runs there)", () => {
    wrap(null);
    expect(screen.getByText(/abrí ELISE Desktop/)).toBeTruthy();
  });

  it("ADR-110: a Broadlink by IP — a public address is refused; a LAN one continues its setup", async () => {
    const r = runtime({
      addBroadlink: vi.fn(async (host: string) =>
        host === "8.8.8.8"
          ? { kind: "aborted" as const, reason: "invalid_host" }
          : {
              kind: "form" as const,
              flowId: "abcdef0123456789",
              title: null,
              fields: [{ name: "name", type: "text" as const, required: true }],
              errors: {},
            },
      ),
    });
    wrap(r);
    const host = screen.getByLabelText("IP o nombre en tu red");
    const submit = within(host.closest("form")!).getByRole("button", { name: "Agregar" });
    fireEvent.change(host, { target: { value: "8.8.8.8" } });
    await act(async () => fireEvent.click(submit));
    expect(screen.getByRole("alert").textContent).toMatch(/dirección de tu red/);
    fireEvent.change(screen.getByLabelText("IP o nombre en tu red"), {
      target: { value: "192.168.1.40" },
    });
    await act(async () =>
      fireEvent.click(
        within(screen.getByLabelText("IP o nombre en tu red").closest("form")!).getByRole(
          "button",
          { name: "Agregar" },
        ),
      ),
    );
    expect(r.addBroadlink).toHaveBeenLastCalledWith("192.168.1.40");
    expect(screen.getByLabelText("Nombre")).toBeTruthy();
  });
});

/**
 * ADR-128: "found now" is only this search; what was seen before is folded apart and never
 * counted as found now; a newer search drops an older one's late answer.
 */
describe("this search vs before", () => {
  it("no current results: says so, with no contradiction, even with devices seen before", async () => {
    wrap(runtime({ discoveries: vi.fn(async () => []) }), vi.fn(), {
      found: [seen("d1", "FlowBox-Z3"), seen("d2", "FlowBox-Z3"), seen("d3", "TV Living")],
    });
    expect(
      await screen.findByText("No se encontraron dispositivos nuevos", {}, { timeout: 4000 }),
    ).toBeTruthy();
    expect(screen.queryByText(/encontrados? ahora/)).toBeNull();
    expect(screen.queryByText(/seguimos buscando/)).toBeNull();
    // The history is folded by default, with its own count; two rows with one name stay two.
    const summary = screen.getByText("Encontrados anteriormente (3)");
    const details = summary.closest("details")!;
    expect(details.open).toBe(false);
    fireEvent.click(summary);
    expect(details.open).toBe(true);
    expect(within(details).getAllByText("FlowBox-Z3")).toHaveLength(2);
    fireEvent.click(summary);
    expect(details.open).toBe(false);
  });

  it("current results are counted alone; the history isn't part of the count", async () => {
    wrap(runtime(), vi.fn(), { found: [seen("d1", "Android TV")] });
    expect(await screen.findByText("2 encontrados ahora", {}, { timeout: 4000 })).toBeTruthy();
    expect(screen.queryByText("No se encontraron dispositivos nuevos")).toBeNull();
    expect(screen.getByText("Encontrados anteriormente (1)")).toBeTruthy();
  });

  it("“Volver a buscar” clears only the last search's results; the history stays", async () => {
    const next = deferred<DiscoveredDevice[]>();
    const discoveries = vi
      .fn()
      .mockResolvedValueOnce([{ flowId: TV, name: "Living TV", kind: "cast" }])
      .mockReturnValueOnce(next.promise);
    wrap(runtime({ discoveries }), vi.fn(), { found: [seen("d1", "Viejo")] });
    expect(await screen.findByText("1 encontrado ahora", {}, { timeout: 4000 })).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /Volver a buscar/ })));
    expect(screen.queryByText("Living TV")).toBeNull();
    expect(screen.getByText("Buscando en tu red…")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Volver a buscar/ })).toBeDisabled();
    expect(screen.getByText("Encontrados anteriormente (1)")).toBeTruthy();
    next.resolve([]);
    expect(
      await screen.findByText("No se encontraron dispositivos nuevos", {}, { timeout: 4000 }),
    ).toBeTruthy();
  });

  it("an answer arriving after the dialog closed is dropped", async () => {
    const late = deferred<DiscoveredDevice[]>();
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const view = wrap(runtime({ discoveries: vi.fn(() => late.promise) }));
    await act(async () => new Promise((r) => setTimeout(r, 10)));
    view.unmount();
    late.resolve([{ flowId: TV, name: "Living TV", kind: "cast" }]);
    await act(async () => new Promise((r) => setTimeout(r, 2400)));
    // The stale search never completed (its diagnostics line is the completion's).
    expect(info).not.toHaveBeenCalled();
    info.mockRestore();
  });

  it("diagnostics are counts and integrations only — no names", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    wrap(runtime());
    await screen.findByText("2 encontrados ahora", {}, { timeout: 4000 });
    expect(info).toHaveBeenCalledWith(
      "[home-discovery]",
      expect.objectContaining({ current: 2, previous: 0, integrations: ["hue", "cast"] }),
    );
    expect(JSON.stringify(info.mock.calls)).not.toMatch(/Living TV|Hue Bridge/);
    info.mockRestore();
  });

  it("an engine that fails ends the search as failed, never 'still looking'", async () => {
    wrap(runtime({ discoveries: vi.fn(async () => Promise.reject(new Error("down"))) }));
    expect(
      await screen.findByText(
        "No se pudo buscar en tu red. Probá de nuevo.",
        {},
        { timeout: 4000 },
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: /Volver a buscar/ })).not.toBeDisabled();
  });

  it("only a few current results show until the person asks for all", async () => {
    const many = Array.from({ length: 8 }, (_, i) => ({
      flowId: `01JABCDEFGHJKMNPQRSTVWXY${i}${i}`,
      name: `Luz ${i}`,
      kind: "hue",
    }));
    wrap(runtime({ discoveries: vi.fn(async () => many) }));
    expect(await screen.findByText("8 encontrados ahora", {}, { timeout: 4000 })).toBeTruthy();
    expect(screen.queryByText("Luz 7")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Ver los 8" }));
    expect(screen.getByText("Luz 7")).toBeTruthy();
  });

  it("in a dialog: no 'Omitir por ahora' (its × closes); status announced; two labeled blocks", async () => {
    wrap(runtime(), vi.fn(), { skippable: false });
    await screen.findByText("2 encontrados ahora", {}, { timeout: 4000 });
    expect(screen.queryByRole("button", { name: "Omitir por ahora" })).toBeNull();
    expect(screen.getByRole("status").textContent).toMatch(/2 encontrados ahora/);
    expect(screen.getByRole("heading", { name: "En esta red" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Servicios conectados" })).toBeTruthy();
  });
});

/** ADR-119/128: the Smart Life row shows what the server can really do, plainly. */
describe("Smart Life row", () => {
  const status = vi.mocked(actions.tuyaStatusAction);
  const value = (v: object) =>
    ({ ok: true, value: v }) as unknown as Awaited<ReturnType<typeof actions.tuyaStatusAction>>;
  const linked = (over: object = {}) => ({
    availability: { state: "unavailable" },
    testLink: true,
    connections: [
      {
        id: "c1",
        region: "us",
        label: "Smart Life · US",
        status: "connected",
        problem: null,
        test: true,
        ...over,
      },
    ],
  });

  it("nothing to connect with: a disabled Conectar, short and plain", async () => {
    status.mockResolvedValueOnce(
      value({ availability: { state: "unavailable" }, testLink: false, connections: [] }),
    );
    wrap(null);
    expect(await screen.findByRole("button", { name: "Conectar" })).toBeDisabled();
    expect(screen.getByText("Todavía no disponible")).toBeTruthy();
    expect(screen.queryByText(/habilitaci|OAuth|prueba|desarrollo/i)).toBeNull();
  });

  it("the owner's account connects with a normal Conectar; no test wording anywhere", async () => {
    vi.mocked(actions.tuyaOverviewAction).mockResolvedValue({
      ok: true,
      value: {
        hubs: [
          {
            id: "hub1",
            name: "Infrarrojo Habitación",
            online: true,
            failed: false,
            remotes: [
              {
                infraredId: "hub1",
                remoteId: "rm1",
                name: "Aire Acondicionado Pieza",
                brand: "Fedders",
                kind: "ac",
                deviceId: null,
                sameAs: null,
              },
            ],
          },
        ],
        otherDevices: 2,
      },
    } as never);
    status
      .mockResolvedValueOnce(
        value({ availability: { state: "unavailable" }, testLink: true, connections: [] }),
      )
      .mockResolvedValue(value(linked()));
    wrap(null);
    const connect = await screen.findByRole("button", { name: "Conectar" });
    expect(connect).not.toBeDisabled();
    await act(async () => fireEvent.click(connect));
    expect(actions.linkTuyaTestAction).toHaveBeenCalled();
    // Connected: "Smart Life" and "Conectado", the region out of the name; remotes listed at once.
    expect(await screen.findByText("Smart Life")).toBeTruthy();
    expect(screen.getByText("Conectado")).toBeTruthy();
    expect(screen.queryByText(/US/)).toBeNull();
    const name = await screen.findByText("Aire Acondicionado Pieza");
    expect(name).toHaveAttribute("title", "Aire Acondicionado Pieza");
    expect(screen.queryByText(/prueba|desarrollo|todavía no se pueden controlar/i)).toBeNull();
    // Sync and disconnect are icons, named for screen readers; disconnecting asks first.
    expect(screen.getByRole("button", { name: "Sincronizar" })).toHaveAttribute("title");
    fireEvent.click(screen.getByRole("button", { name: "Desconectar" }));
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect(actions.disconnectTuyaAction).not.toHaveBeenCalled();
    status.mockReset();
    status.mockResolvedValue(value({ availability: { state: "off" }, connections: [] }));
  });
});

/** ADR-128: a remote laid out like one — never every button loose in a box. */
describe("remote control", () => {
  const remote = (cap: object, state = {}) =>
    ({
      id: "d1",
      name: "Tele",
      aliases: [],
      roomId: null,
      type: "media_player",
      capabilities: [cap],
      state,
      available: true,
      stateUpdatedAt: null,
      favorite: false,
    }) as unknown as HomeDevice;
  const tuya = (kind: string, keys: [string, string][], ac?: object) => ({
    type: "tuya_ir",
    connectionId: "33333333-3333-4333-8333-333333333333",
    infraredId: "hub1",
    remoteId: "rm1",
    categoryId: kind === "ac" ? 5 : 2,
    kind,
    keys: keys.map(([key, label]) => ({ key, label, tuya: key })),
    ...(ac ? { ac } : {}),
  });
  const show = (device: HomeDevice, send = vi.fn()) => {
    render(
      <I18nProvider locale="es">
        <RemoteControl device={device} disabled={false} send={send} />
      </I18nProvider>,
    );
    return send;
  };

  it("a TV: power, volume and channel rockers, navigation icons; extras folded", () => {
    const send = show(
      remote(
        tuya("tv", [
          ["power_toggle", "Encendido"],
          ["volume_up", "Subir volumen"],
          ["volume_down", "Bajar volumen"],
          ["channel_up", "Canal +"],
          ["channel_down", "Canal −"],
          ["back", "Back"],
          ["home", "Home"],
          ["menu", "Menu"],
          ["netflix", "Netflix"],
        ]),
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Encendido" }));
    expect(send).toHaveBeenLastCalledWith([{ type: "button", value: "power_toggle" }]);
    expect(within(screen.getByRole("group", { name: "Vol" })).getAllByRole("button")).toHaveLength(
      2,
    );
    expect(
      within(screen.getByRole("group", { name: "Canal" })).getAllByRole("button"),
    ).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(send).toHaveBeenLastCalledWith([{ type: "button", value: "back" }]);
    // What has no place on a remote is one tap away, folded.
    const more = screen.getByText("Más botones (1)").closest("details")!;
    expect(more.open).toBe(false);
  });

  it("an AC: power, a temperature stepper within its range, mode and fan", () => {
    const ac = {
      modes: [
        { mode: "cool", temps: [16, 17, 18], fans: ["auto", "low"] },
        { mode: "heat", temps: [20, 21], fans: ["auto"] },
      ],
    };
    const send = show(
      remote(
        tuya(
          "ac",
          [
            ["power_on", "Encender"],
            ["power_off", "Apagar"],
          ],
          ac,
        ),
        {
          on: true,
          hvacMode: "cool",
          targetTemperature: 17,
          fanMode: "auto",
        },
      ),
    );
    expect(screen.getByText("17")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Subir temperatura" }));
    expect(send).toHaveBeenLastCalledWith([{ type: "temperature", value: 18 }]);
    fireEvent.click(screen.getByRole("button", { name: /Calor/ }));
    expect(send).toHaveBeenLastCalledWith([{ type: "hvac_mode", value: "heat" }]);
    fireEvent.click(screen.getByRole("button", { name: "Baja" }));
    expect(send).toHaveBeenLastCalledWith([{ type: "fan_mode", value: "low" }]);
    fireEvent.click(screen.getByRole("button", { name: /Apagar/ }));
    expect(send).toHaveBeenLastCalledWith([{ type: "power", value: false }]);
    expect(screen.getByRole("button", { name: /Encender/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    // Power keys are the power control, not loose extras.
    expect(screen.queryByText(/Más botones/)).toBeNull();
  });

  it("Hogar's screens never say 'estimado'; the assistant still does", () => {
    const d = remote(tuya("tv", [["power_toggle", "Encendido"]]), { on: true, estimated: true });
    expect(describeState(d, "es", { estimate: false })).not.toMatch(/estimado/);
    expect(describeState(d, "es")).toMatch(/estimado/);
  });
});

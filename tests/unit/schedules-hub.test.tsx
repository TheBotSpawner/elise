// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ScheduleView } from "@/application/schedules-service";
import { ConfirmProvider } from "@/components/ui/confirm";
import { morningBriefConfigSchema } from "@/core/schedules/schedule";
import { SchedulesView } from "@/features/schedules/schedules-view";
import { I18nProvider } from "@/lib/i18n/client";

const actions = vi.hoisted(() => ({
  createScheduleAction: vi.fn(),
  updateScheduleAction: vi.fn(),
  pauseScheduleAction: vi.fn(),
  deleteScheduleAction: vi.fn(),
  runNowAction: vi.fn(),
  cancelRunAction: vi.fn(),
  historyAction: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@/hooks/use-realtime-refresh", () => ({ useRealtimeRefresh: () => undefined }));
vi.mock("@/features/schedules/actions", () => actions);

const TZ = "America/Argentina/Buenos_Aires";
const SPACE = "22222222-2222-4222-8222-222222222222";

/** A Morning Brief created before presets existed: no preset, horizon or Knowledge fields. */
const legacyBrief: ScheduleView = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Morning Brief",
  status: "active",
  timezone: TZ,
  definition: { kind: "weekly", days: [1, 2, 3, 4, 5], time: "07:30" },
  input: {
    name: "Morning Brief",
    actionType: "morning_brief",
    definition: { kind: "weekly", days: [1, 2, 3, 4, 5], time: "07:30" },
    timezone: TZ,
    configuration: morningBriefConfigSchema.parse({ blocks: ["calendar", "email", "tasks"] }),
    instructions: null,
    delivery: { notify: "in_app" },
  },
  capabilities: ["calendar", "email", "tasks"],
  nextRunAt: "2026-10-05T10:30:00Z",
  lastRun: null,
};

function view(schedules: ScheduleView[] = [legacyBrief]) {
  return render(
    <I18nProvider locale="es">
      <ConfirmProvider>
        <SchedulesView
          schedules={schedules}
          workspaceId="ws"
          timezone={TZ}
          spaces={[{ id: SPACE, path: "Firbot Marketing" }]}
          backgroundAvailable
          draft={null}
        />
      </ConfirmProvider>
    </I18nProvider>,
  );
}

beforeEach(() => {
  for (const fn of Object.values(actions)) fn.mockReset();
  actions.createScheduleAction.mockResolvedValue({ ok: true, value: "new-id" });
  actions.pauseScheduleAction.mockResolvedValue({ ok: true, value: undefined });
  actions.historyAction.mockResolvedValue({ ok: true, value: [] });
  window.scrollTo = vi.fn();
  // jsdom has <dialog> without showModal/close, and no matchMedia (desktop: anchored menus).
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.removeAttribute("open");
  };
  window.matchMedia = vi.fn().mockReturnValue({ matches: true }) as never;
});

/** Secondary actions live behind "⋯" (ADR-067). */
function menuItem(name: string) {
  fireEvent.click(screen.getByRole("button", { name: "Más acciones" }));
  return screen.getByRole("menuitem", { name });
}

describe("Scheduled hub (ADR-037)", () => {
  it("leads with a generic New scheduled task, your tasks first, ideas after", () => {
    view();
    expect(screen.getByRole("button", { name: "Nueva tarea programada" })).toBeInTheDocument();
    expect(screen.queryByText("Nuevo Morning Brief")).toBeNull();
    const yours = screen.getByText("Tus tareas programadas");
    const ideas = screen.getByText("Ideas para tus programados");
    expect(yours.compareDocumentPosition(ideas) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // One primary action on the card; the rest in its ⋯ menu, delete last.
    expect(screen.getByRole("button", { name: "Ejecutar ahora" })).toBeInTheDocument();
    for (const name of ["Pausar", "Editar", "Historial"])
      expect(screen.queryByRole("button", { name })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Más acciones" }));
    expect(screen.getAllByRole("menuitem").map((m) => m.textContent)).toEqual([
      "Pausar",
      "Editar",
      "Historial",
      "Eliminar",
    ]);
  });

  it("the existing Morning Brief is recognised: its idea says Already added and opens it", () => {
    view();
    const idea = screen.getByRole("button", { name: /Resumen del día/ });
    expect(within(idea).getByText(/Ya agregada/)).toBeInTheDocument();
    fireEvent.click(idea);
    expect(screen.getByText("Editar “Morning Brief”")).toBeInTheDocument();
  });

  it("an idea prefills the generic editor; nothing is created until Create", async () => {
    view();
    fireEvent.click(screen.getByRole("button", { name: /Planificación semanal/ }));
    expect(screen.getByText("Nueva tarea programada", { selector: "h2" })).toBeInTheDocument();
    expect(screen.getByLabelText("Nombre")).toHaveValue("Planificación semanal");
    expect(
      (screen.getByLabelText("¿Qué debería hacer ELISE?") as HTMLTextAreaElement).value,
    ).toContain("Planificá la semana que viene");
    expect(screen.getByLabelText("Días de la agenda")).toHaveValue("week");
    expect(
      screen.getByText(/Se ejecuta: Dom · 19:00 · hora de Buenos Aires, Argentina/),
    ).toBeInTheDocument();
    expect(actions.createScheduleAction).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Crear" }));
    });
    const input = actions.createScheduleAction.mock.calls[0]![0];
    expect(input).toMatchObject({
      name: "Planificación semanal",
      actionType: "morning_brief",
      definition: { kind: "weekly", days: [0], time: "19:00" },
      configuration: {
        blocks: ["calendar", "tasks", "goals", "weather"],
        horizon: "week",
        preset: "weekly_planning",
      },
    });
  });

  it("task review looks only at tasks", () => {
    view();
    fireEvent.click(screen.getByRole("button", { name: /Repaso de tareas/ }));
    expect(screen.getByRole("checkbox", { name: /Tareas/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Agenda" })).not.toBeChecked();
    expect(screen.queryByLabelText("Días de la agenda")).toBeNull();
  });

  it("the Knowledge digest asks which Space before it can be created", async () => {
    view();
    fireEvent.click(screen.getByRole("button", { name: /Resumen de Conocimiento/ }));
    const create = screen.getByRole("button", { name: "Crear" });
    expect(create).toBeDisabled();
    expect(screen.getByText("Elegí qué Espacio resumir.")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Espacio de Conocimiento"), {
      target: { value: SPACE },
    });
    expect(create).toBeEnabled();
    await act(async () => {
      fireEvent.click(create);
    });
    expect(actions.createScheduleAction.mock.calls[0]![0].configuration).toMatchObject({
      blocks: ["knowledge"],
      knowledgeSpaceId: SPACE,
    });
  });

  it("a generic task starts blank: the user names it and says what ELISE should do", () => {
    view();
    fireEvent.click(screen.getByRole("button", { name: "Nueva tarea programada" }));
    expect(screen.getByLabelText("Nombre")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Crear" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Nombre"), { target: { value: "Resumen del lunes" } });
    expect(screen.getByRole("button", { name: "Crear" })).toBeEnabled();
  });

  it("empty: the CTA and the ideas, never a blank page", () => {
    view([]);
    expect(screen.getByText("Todavía no hay nada programado")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Nueva tarea programada" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Resumen del día/ })).toBeInTheDocument();
    expect(screen.queryByText(/Ya agregada/)).toBeNull();
  });

  it("pauses and shows history through the same controls", async () => {
    view();
    const pausar = menuItem("Pausar");
    await act(async () => {
      fireEvent.click(pausar);
    });
    expect(actions.pauseScheduleAction).toHaveBeenCalledWith(legacyBrief.id, true);
    const historial = menuItem("Historial");
    await act(async () => {
      fireEvent.click(historial);
    });
    expect(actions.historyAction).toHaveBeenCalledWith(legacyBrief.id);
    view([{ ...legacyBrief, id: "33333333-3333-4333-8333-333333333333", status: "paused" }]);
    expect(screen.getAllByText("Pausado").length).toBeGreaterThan(0);
    fireEvent.click(screen.getAllByRole("button", { name: "Más acciones" }).at(-1)!);
    expect(screen.getByRole("menuitem", { name: "Reanudar" })).toBeInTheDocument();
  });

  it("no delivery choice anywhere; editing a legacy 'browser' schedule saves in_app and keeps the rest", async () => {
    actions.updateScheduleAction.mockResolvedValue({ ok: true, value: undefined });
    const legacy: ScheduleView = {
      ...legacyBrief,
      input: { ...legacyBrief.input, delivery: { notify: "browser" } },
    };
    view([legacy]);
    fireEvent.click(menuItem("Editar"));
    expect(screen.getByText("Editar “Morning Brief”")).toBeInTheDocument();
    for (const gone of ["Cuando esté listo", "En ELISE", "Notificación del navegador", "Sin aviso"])
      expect(screen.queryByText(gone)).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    });
    expect(actions.updateScheduleAction).toHaveBeenCalledWith(legacy.id, {
      ...legacy.input,
      delivery: { notify: "in_app" },
    });
  });

  it("a new scheduled task offers no delivery choice either", () => {
    view([]);
    fireEvent.click(screen.getByRole("button", { name: "Nueva tarea programada" }));
    expect(screen.queryByText("Cuando esté listo")).toBeNull();
    expect(screen.queryByRole("combobox", { name: /listo|ready/i })).toBeNull();
  });
});

describe("Programados editor and cards (ADR-067)", () => {
  const isOpen = () => screen.queryByLabelText("Nombre") !== null;

  it("create opens a modal over the page — never an inline form — and Cancel closes it", () => {
    view();
    fireEvent.click(screen.getByRole("button", { name: "Nueva tarea programada" }));
    const dialog = screen.getByLabelText("Nombre").closest("dialog")!;
    expect(dialog).not.toBeNull();
    expect(dialog).toHaveAttribute("open");
    // The dimmed, blurred backdrop and the wide desktop size.
    expect(dialog.className).toMatch(/backdrop:backdrop-blur/);
    expect(dialog.className).toMatch(/sm:max-w-3xl/);
    // The list stays where it was, under the modal.
    expect(screen.getByText("Tus tareas programadas").closest("dialog")).toBeNull();
    fireEvent.click(within(dialog).getAllByRole("button", { name: "Cancelar" }).at(-1)!);
    expect(isOpen()).toBe(false);
  });

  it("edit opens the same modal with the schedule's values", () => {
    view();
    fireEvent.click(menuItem("Editar"));
    expect(screen.getByLabelText("Nombre").closest("dialog")).toHaveAttribute("open");
    expect(screen.getByLabelText("Nombre")).toHaveValue("Morning Brief");
  });

  it("unsaved changes: asks before discarding, and can keep editing", () => {
    view();
    fireEvent.click(screen.getByRole("button", { name: "Nueva tarea programada" }));
    fireEvent.change(screen.getByLabelText("Nombre"), { target: { value: "Algo" } });
    const cancel = () =>
      fireEvent.click(screen.getAllByRole("button", { name: "Cancelar" }).at(-1)!);
    cancel();
    expect(screen.getByRole("alert")).toHaveTextContent("Tenés cambios sin guardar.");
    fireEvent.click(screen.getByRole("button", { name: "Seguir editando" }));
    expect(screen.getByLabelText("Nombre")).toHaveValue("Algo");
    cancel();
    fireEvent.click(screen.getByRole("button", { name: "Descartar cambios" }));
    expect(isOpen()).toBe(false);
  });

  it("saving closes the modal", async () => {
    view();
    fireEvent.click(screen.getByRole("button", { name: /Planificación semanal/ }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Crear" }));
    });
    expect(actions.createScheduleAction).toHaveBeenCalled();
    expect(isOpen()).toBe(false);
  });

  it("settings appear only for what ELISE looks at (progressive disclosure)", () => {
    view();
    fireEvent.click(screen.getByRole("button", { name: "Nueva tarea programada" }));
    expect(screen.queryByLabelText("Temas de noticias")).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: /Noticias/ }));
    expect(screen.getByLabelText("Temas de noticias")).toBeInTheDocument();
  });

  it("run now is the card's primary action; delete asks first", async () => {
    actions.runNowAction.mockResolvedValue({
      ok: false,
      error: { code: "RATE_LIMITED", message: "" },
    });
    view();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Ejecutar ahora" }));
    });
    expect(actions.runNowAction).toHaveBeenCalledWith(legacyBrief.id);
    fireEvent.click(menuItem("Eliminar"));
    // ELISE's own confirmation, never the native one: cancelling deletes nothing.
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: "Cancelar" }));
    });
    expect(actions.deleteScheduleAction).not.toHaveBeenCalled();
  });

  it("filters: active, paused, all", () => {
    view([
      legacyBrief,
      {
        ...legacyBrief,
        id: "44444444-4444-4444-8444-444444444444",
        name: "Cierre",
        status: "paused",
      },
    ]);
    fireEvent.click(screen.getByRole("button", { name: /^Pausados/ }));
    expect(screen.queryByText("Morning Brief", { selector: "p" })).toBeNull();
    expect(screen.getByText("Cierre", { selector: "p" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Todos/ }));
    expect(screen.getByText("Morning Brief", { selector: "p" })).toBeInTheDocument();
  });

  it("templates show their icon, cadence and what they look at", () => {
    view([]);
    const idea = screen.getByRole("button", { name: /Seguimiento de mails/ });
    expect(idea).toHaveTextContent("Días de semana · 16:00");
    expect(idea).toHaveTextContent("Correos");
    expect(idea.querySelector("svg")).not.toBeNull();
  });
});

// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ScheduleView } from "@/application/schedules-service";
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
      <SchedulesView
        schedules={schedules}
        workspaceId="ws"
        timezone={TZ}
        spaces={[{ id: SPACE, path: "Firbot Marketing" }]}
        backgroundAvailable
        draft={null}
      />
    </I18nProvider>,
  );
}

beforeEach(() => {
  for (const fn of Object.values(actions)) fn.mockReset();
  actions.createScheduleAction.mockResolvedValue({ ok: true, value: "new-id" });
  actions.pauseScheduleAction.mockResolvedValue({ ok: true, value: undefined });
  actions.historyAction.mockResolvedValue({ ok: true, value: [] });
  window.scrollTo = vi.fn();
});

describe("Scheduled hub (ADR-037)", () => {
  it("leads with a generic New scheduled task, your tasks first, ideas after", () => {
    view();
    expect(screen.getByRole("button", { name: "Nueva tarea programada" })).toBeInTheDocument();
    expect(screen.queryByText("Nuevo Morning Brief")).toBeNull();
    const yours = screen.getByText("Tus tareas programadas");
    const ideas = screen.getByText("Ideas para ELISE");
    expect(yours.compareDocumentPosition(ideas) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The existing Morning Brief keeps its controls.
    for (const name of ["Ejecutar ahora", "Pausar", "Editar", "Historial", "Eliminar"])
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
  });

  it("the existing Morning Brief is recognised: its idea says Already added and opens it", () => {
    view();
    const idea = screen.getByRole("button", { name: /^Morning Brief/ });
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
      screen.getByText(/Se ejecuta: Dom · 19:00 · hora de America\/Argentina/),
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
        blocks: ["calendar", "tasks", "goals"],
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
    expect(screen.getByRole("button", { name: /Morning Brief/ })).toBeInTheDocument();
    expect(screen.queryByText(/Ya agregada/)).toBeNull();
  });

  it("pauses and shows history through the same controls", async () => {
    view();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Pausar" }));
    });
    expect(actions.pauseScheduleAction).toHaveBeenCalledWith(legacyBrief.id, true);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Historial" }));
    });
    expect(actions.historyAction).toHaveBeenCalledWith(legacyBrief.id);
    view([{ ...legacyBrief, id: "33333333-3333-4333-8333-333333333333", status: "paused" }]);
    expect(screen.getAllByText("Pausado").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Reanudar" })).toBeInTheDocument();
  });
});

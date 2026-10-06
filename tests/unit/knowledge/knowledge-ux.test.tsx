// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SourceView, SpaceSummary } from "@/application/knowledge-service";
import { NotionPicker } from "@/features/knowledge/source-pickers";
import { SpaceView } from "@/features/knowledge/space-view";
import { I18nProvider } from "@/lib/i18n/client";

const actions = vi.hoisted(() => ({
  sourceProblemsAction: vi.fn(),
  retryProblemsAction: vi.fn(),
  retryItemAction: vi.fn(),
  searchNotionAction: vi.fn(),
  addSourceAction: vi.fn(),
  syncNowAction: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@/hooks/use-realtime-refresh", () => ({ useRealtimeRefresh: () => undefined }));
vi.mock("@/features/knowledge/actions", () => actions);

const totals = { total: 0, ready: 0, processing: 0, attention: 0 };
const space = (over: Partial<SpaceSummary> = {}): SpaceSummary => ({
  id: "sec-1",
  name: "AMII",
  parentId: "space-1",
  path: "UTN › AMII",
  description: null,
  context: null,
  icon: "book",
  color: "blue",
  counts: { ready: 0, processing: 0, attention: 0 },
  sources: totals,
  sourceCount: 0,
  sourceTypes: [],
  updatedAt: "2026-10-01T00:00:00Z",
  ...over,
});

const notionSource = (over: Partial<SourceView> = {}): SourceView => ({
  id: "src-1",
  sourceType: "notion",
  name: "Projects",
  status: "ready",
  live: false,
  state: "up_to_date",
  rollup: "needs_attention",
  kind: "database",
  phase: null,
  lastSyncedAt: "2026-10-03T10:00:00Z",
  nextSyncAt: null,
  lastErrorCode: null,
  counts: { ready: 344, processing: 0, attention: 2 },
  discovered: 346,
  lastRunAt: "2026-10-03T10:00:00Z",
  runningSince: null,
  ...over,
});

function view(sources: SourceView[], opts: { attention?: boolean } = {}) {
  const parent = space({ id: "space-1", name: "UTN", parentId: null, path: "UTN" });
  const section = space({
    sources: { total: sources.length, ready: 0, processing: 0, attention: 1 },
    sourceCount: sources.length,
  });
  return render(
    <I18nProvider locale="es">
      <SpaceView
        space={section}
        sections={[]}
        sources={sources}
        items={[]}
        accounts={[]}
        allSpaces={[parent, section]}
        workspaceId="ws"
        notionAvailable
        backgroundAvailable
        initialAttention={opts.attention}
      />
    </I18nProvider>,
  );
}

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.open = false;
  };
  for (const fn of Object.values(actions)) fn.mockReset();
  actions.sourceProblemsAction.mockResolvedValue({
    ok: true,
    value: {
      total: 2,
      problems: [
        {
          id: "i1",
          title: "Project Alpha",
          status: "needs_attention",
          errorCode: "NOT_FOUND",
          detail: "That page or database is no longer shared with ELISE",
          sourceUrl: "https://notion.so/alpha",
          updatedAt: "2026-10-03T10:00:00Z",
        },
        {
          id: "i2",
          title: "Project Beta",
          status: "failed",
          errorCode: "VALIDATION_ERROR",
          detail: "This document has no readable text",
          sourceUrl: null,
          updatedAt: "2026-10-03T10:00:00Z",
        },
      ],
    },
  });
  actions.retryProblemsAction.mockResolvedValue({ ok: true, value: { retried: 2 } });
});

describe("Live connected sources (ADR-046)", () => {
  it("a connected Notion database is one source that says Disponible — no indexing counts", () => {
    view([
      notionSource({
        live: true,
        state: "available",
        rollup: "ready",
        counts: { ready: 0, processing: 0, attention: 0 },
        discovered: null,
      }),
    ]);
    expect(screen.getByText(/Disponible/)).toBeInTheDocument();
    expect(screen.queryByText(/indexad|listos|Preparando|Indexando/i)).toBeNull();
  });
});

describe("Space sources (ADR-037)", () => {
  it("adds a source from the header and from the Sources list, with the same flow and destination", () => {
    view([notionSource()]);
    const buttons = screen.getAllByRole("button", { name: "Sumar fuente" });
    expect(buttons).toHaveLength(2);
    for (const button of buttons) {
      fireEvent.click(button);
      const dialog = screen.getByRole("dialog", { name: "Sumar fuente" });
      // A Section's source goes to the Section, never its parent Space.
      expect(within(dialog).getByText("Se suma a UTN › AMII")).toBeInTheDocument();
      expect(within(dialog).getByRole("button", { name: /Notion/ })).toBeInTheDocument();
      fireEvent(dialog, new Event("cancel", { cancelable: true }));
      expect(screen.queryByRole("dialog", { name: "Sumar fuente" })).toBeNull();
    }
  });

  it("a Notion database is one source, labelled as a database, with its attention clickable", async () => {
    view([notionSource()]);
    expect(screen.getByText("Projects")).toBeInTheDocument();
    expect(screen.getByText("Base de datos de Notion")).toBeInTheDocument();
    expect(screen.getByText(/1 fuente$/)).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: /Necesita atención · 2 necesitan atención/ }),
    );
    const dialog = await screen.findByRole("dialog", { name: /Projects: qué necesita atención/ });
    expect(
      within(dialog).getByText(/344 elementos listos · 2 necesitan atención/),
    ).toBeInTheDocument();
    // Only the problem children, each with its reason in plain words.
    expect(await within(dialog).findByText("Project Alpha")).toBeInTheDocument();
    expect(within(dialog).getByText(/ELISE perdió el acceso a esta página/)).toBeInTheDocument();
    expect(within(dialog).getByText(/no tiene texto que ELISE pueda leer/)).toBeInTheDocument();
    // Raw provider codes are behind "Detalles técnicos".
    expect(within(dialog).getAllByText("Detalles técnicos").length).toBeGreaterThan(0);
    expect(within(dialog).getAllByRole("link", { name: "Reconectar" }).length).toBeGreaterThan(0);
  });

  it("retries the failed children of a source", async () => {
    view([notionSource()]);
    fireEvent.click(screen.getByRole("button", { name: /Necesita atención · 2/ }));
    const dialog = await screen.findByRole("dialog", { name: /qué necesita atención/ });
    await within(dialog).findByText("Project Alpha");
    await act(async () => {
      fireEvent.click(
        within(dialog).getByRole("button", { name: "Reintentar los 2 elementos fallidos" }),
      );
    });
    expect(actions.retryProblemsAction).toHaveBeenCalledWith("src-1");
  });

  it("a source that failed explains itself and offers reconnecting", async () => {
    view([
      notionSource({
        state: "needs_attention",
        lastErrorCode: "AUTH_EXPIRED",
        counts: { ready: 0, processing: 0, attention: 0 },
        rollup: "failed",
      }),
    ]);
    fireEvent.click(screen.getByRole("button", { name: "No se pudo leer" }));
    const dialog = await screen.findByRole("dialog", { name: /qué necesita atención/ });
    expect(within(dialog).getByText(/ELISE perdió el acceso a esta cuenta/)).toBeInTheDocument();
    expect(within(dialog).getAllByRole("link", { name: "Reconectar" })[0]).toHaveAttribute(
      "href",
      "/connections",
    );
  });

  it("a syncing source is processing, not needs attention", () => {
    view([notionSource({ state: "syncing", rollup: "processing", phase: "reading" })]);
    expect(screen.queryByRole("button", { name: /Necesita atención/ })).toBeNull();
    expect(screen.getByText(/Sincronizando…/)).toBeInTheDocument();
  });

  it("from a card's '1 necesita atención', lists the affected sources and drills into one", async () => {
    view([notionSource(), notionSource({ id: "src-2", name: "Companies", rollup: "ready" })], {
      attention: true,
    });
    const dialog = screen.getByRole("dialog", { name: "Fuentes que necesitan atención" });
    expect(within(dialog).queryByText("Companies")).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: /Projects/ }));
    expect(await screen.findByText("Project Alpha")).toBeInTheDocument();
    expect(actions.sourceProblemsAction).toHaveBeenCalledWith("src-1");
  });
});

describe("Notion picker", () => {
  const accounts = [
    { connectionId: "c1", provider: "notion" as const, name: "Firbot", account: null, ready: true },
  ];

  it("lists databases by default, marks the ones already added, and searches pages apart", async () => {
    actions.searchNotionAction.mockImplementation(async (_c: string, _q: string, kind: string) => ({
      ok: true,
      value:
        kind === "database"
          ? [
              { id: "db1", name: "Projects", kind: "database", added: true },
              { id: "db2", name: "Companies", kind: "database", added: false },
            ]
          : [{ id: "p1", name: "Firbot HR Hub", kind: "page", added: false }],
    }));
    render(
      <I18nProvider locale="es">
        <NotionPicker spaceId="sec-1" accounts={accounts} notionAvailable onDone={vi.fn()} />
      </I18nProvider>,
    );
    expect(screen.getByRole("tab", { name: "Bases de datos" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(await screen.findByText("Projects")).toBeInTheDocument();
    expect(actions.searchNotionAction).toHaveBeenLastCalledWith("c1", "", "database", "sec-1");
    expect(screen.getByText(/Ya agregada/)).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Projects" })).toBeDisabled();
    expect(
      screen.getByText(/ELISE solo ve lo que compartiste con ella en Notion/),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Páginas" }));
    expect(await screen.findByText("Firbot HR Hub")).toBeInTheDocument();
    expect(actions.searchNotionAction).toHaveBeenLastCalledWith("c1", "", "page", "sec-1");
  });

  it("adds each picked database as its own source", async () => {
    actions.searchNotionAction.mockResolvedValue({
      ok: true,
      value: [
        { id: "db2", name: "Companies", kind: "database", added: false },
        { id: "db3", name: "Opportunities", kind: "database", added: false },
      ],
    });
    actions.addSourceAction.mockResolvedValue({
      ok: true,
      value: { added: ["a", "b"], skipped: 0 },
    });
    const onDone = vi.fn();
    render(
      <I18nProvider locale="es">
        <NotionPicker spaceId="sec-1" accounts={accounts} notionAvailable onDone={onDone} />
      </I18nProvider>,
    );
    fireEvent.click(await screen.findByRole("checkbox", { name: "Companies" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Opportunities" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Entender esta fuente" }));
    });
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(actions.addSourceAction).toHaveBeenCalledWith({
      spaceId: "sec-1",
      connectionId: "c1",
      provider: "notion",
      selection: [
        { id: "db2", kind: "database", name: "Companies" },
        { id: "db3", kind: "database", name: "Opportunities" },
      ],
    });
  });
});

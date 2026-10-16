// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthContext } from "@/application/auth-context";
import { recentThreads, type KnowledgeNode } from "@/core/history/links";
import { HistoryOrganizer, ThreadItem, ThreadMenu } from "@/features/history/organize";
import { I18nProvider } from "@/lib/i18n/client";

import { FakeSupabase } from "../fixtures/fake-supabase";

vi.mock("server-only", () => ({}));
const nav = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: nav.refresh, push: vi.fn(), replace: vi.fn() }),
}));
const actions = vi.hoisted(() => ({
  moveThreadAction: vi.fn(),
  renameThreadAction: vi.fn(),
  pinThreadAction: vi.fn(),
  archiveConversationAction: vi.fn(),
  deleteConversationAction: vi.fn(),
  deleteVoiceSessionAction: vi.fn(),
}));
vi.mock("@/features/history/actions", () => actions);

const WS = "ws-a";
const ME = "user-a";
const C1 = "11111111-1111-4111-8111-111111111111";
const GENERAL = "22222222-2222-4222-8222-222222222222";
const FIRBOT = "33333333-3333-4333-8333-333333333333";
const FOREIGN = "44444444-4444-4444-8444-444444444444";

/** Two Spaces here, one in another workspace; one conversation with two messages. */
function world() {
  const db = new FakeSupabase();
  db.rows("knowledge_spaces").push(
    { id: GENERAL, workspace_id: WS, name: "General", status: "active", parent_space_id: null },
    {
      id: FIRBOT,
      workspace_id: WS,
      name: "Firbot Marketing",
      status: "active",
      parent_space_id: null,
    },
    { id: FOREIGN, workspace_id: "ws-b", name: "Ajeno", status: "active", parent_space_id: null },
  );
  db.rows("conversations").push({
    id: C1,
    workspace_id: WS,
    user_id: ME,
    title: "Ajuste de un timer",
    status: "active",
    archived_at: null,
    last_message_at: "2026-10-16T10:00:00Z",
  });
  db.rows("messages").push(
    { id: "m1", conversation_id: C1, role: "user", content: "Poné un timer" },
    { id: "m2", conversation_id: C1, role: "assistant", content: "Listo" },
  );
  db.rows("interaction_sessions").push({
    id: "s1",
    workspace_id: WS,
    conversation_id: C1,
    title: "Timer",
    metadata: {},
  });
  const auth = { db, workspaceId: WS, userId: ME } as unknown as AuthContext;
  return { db, auth };
}

const linked = (db: FakeSupabase) =>
  db
    .rows("interaction_knowledge_links")
    .filter((l) => l.state === "linked")
    .map((l) => l.space_id);

const C = { kind: "conversation" as const, id: C1 };

describe("moving conversations between Spaces (ADR-070)", () => {
  it("Sin Espacio → General → Firbot Marketing → Sin Espacio, one link each time", async () => {
    const { moveThread } = await import("@/application/history-organize-service");
    const { db, auth } = world();
    await moveThread(auth, C, GENERAL);
    expect(linked(db)).toEqual([GENERAL]);
    await moveThread(auth, C, FIRBOT);
    expect(linked(db)).toEqual([FIRBOT]);
    // The old link is a manual removal: ELISE's automatic tagging won't put it back.
    expect(
      db.rows("interaction_knowledge_links").find((l) => l.space_id === GENERAL),
    ).toMatchObject({ state: "removed", source: "manual" });
    await moveThread(auth, C, null);
    expect(linked(db)).toEqual([]);
    expect(db.rows("audit_events").map((e) => e.event_type)).toEqual([
      "conversation.space_changed",
      "conversation.space_changed",
      "conversation.space_changed",
    ]);
    // Nothing is copied: same messages, same timestamps.
    expect(db.rows("messages")).toHaveLength(2);
    expect(db.rows("conversations")[0]!.last_message_at).toBe("2026-10-16T10:00:00Z");
  });

  it("refuses a Space that doesn't exist or belongs to another workspace", async () => {
    const { moveThread } = await import("@/application/history-organize-service");
    const { db, auth } = world();
    await expect(moveThread(auth, C, FOREIGN)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(moveThread(auth, C, "55555555-5555-4555-8555-555555555555")).rejects.toMatchObject(
      { code: "NOT_FOUND" },
    );
    expect(linked(db)).toEqual([]);
  });

  it("refuses someone else's conversation", async () => {
    const { moveThread } = await import("@/application/history-organize-service");
    const { auth } = world();
    const other = { ...auth, userId: "user-b" } as AuthContext;
    await expect(moveThread(other, C, GENERAL)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("rename, pin, archive", () => {
  it("rename changes the title (and locks it against summaries); messages stay", async () => {
    const { renameThread } = await import("@/application/history-organize-service");
    const { db, auth } = world();
    await renameThread(auth, C, "  Timer de cinco minutos ");
    expect(db.rows("conversations")[0]!.title).toBe("Timer de cinco minutos");
    expect(db.rows("interaction_sessions")[0]).toMatchObject({
      title: "Timer de cinco minutos",
      metadata: { titleLocked: true },
    });
    expect(db.rows("messages").map((m) => m.content)).toEqual(["Poné un timer", "Listo"]);
  });

  it("pin is per person; pinned first, never twice", async () => {
    const { pinThread, pinnedThreads } = await import("@/application/history-organize-service");
    const { auth } = world();
    await pinThread(auth, C, true);
    await pinThread(auth, C, true);
    expect([...(await pinnedThreads(auth))]).toEqual([`conversation:${C1}`]);
    const rows = [
      { key: "a", at: "2026-10-16T12:00:00Z", pinned: false },
      { key: "b", at: "2026-10-01T12:00:00Z", pinned: true },
    ];
    expect(recentThreads(rows).map((r) => r.key)).toEqual(["b", "a"]);
    await pinThread(auth, C, false);
    expect([...(await pinnedThreads(auth))]).toEqual([]);
  });

  it("archive hides without deleting; unarchive brings it back", async () => {
    const { setConversationArchived } = await import("@/application/history-organize-service");
    const { listConversations } = await import("@/application/conversations-service");
    const { db, auth } = world();
    await setConversationArchived(auth, C1, true);
    expect(db.rows("conversations")[0]).toMatchObject({ status: "archived", archived_at: null });
    expect(await listConversations(auth, 10)).toEqual([]);
    expect((await listConversations(auth, 10, "archived")).map((c) => c.id)).toEqual([C1]);
    await setConversationArchived(auth, C1, false);
    expect((await listConversations(auth, 10)).map((c) => c.id)).toEqual([C1]);
  });
});

// ── UI ───────────────────────────────────────────────────────────────────────

const NODES: KnowledgeNode[] = [
  {
    id: GENERAL,
    name: "General",
    parentId: null,
    parentName: null,
    archived: false,
    icon: "sparkles",
    color: "cyan",
    aliases: [],
  },
  {
    id: FIRBOT,
    name: "Firbot Marketing",
    parentId: null,
    parentName: null,
    archived: false,
    icon: "megaphone",
    color: "rose",
    aliases: [],
  },
];

function board(over: { primary?: string | null; archived?: boolean; voice?: boolean } = {}) {
  const thread = over.voice ? { kind: "session" as const, id: C1 } : C;
  return render(
    <I18nProvider locale="es">
      <HistoryOrganizer nodes={NODES}>
        <ul>
          <ThreadItem thread={thread} rowKey="k1" title="Ajuste de un timer" place={null}>
            <span>Ajuste de un timer</span>
            <ThreadMenu
              thread={thread}
              rowKey="k1"
              title="Ajuste de un timer"
              primary={over.primary ?? null}
              pinned={false}
              archived={over.archived ?? false}
            />
          </ThreadItem>
        </ul>
      </HistoryOrganizer>
    </I18nProvider>,
  );
}

const openMenu = () =>
  fireEvent.click(
    screen.getByRole("button", { name: "Opciones de conversación: Ajuste de un timer" }),
  );

beforeEach(() => {
  for (const fn of Object.values(actions)) fn.mockReset().mockResolvedValue({ ok: true });
  nav.refresh.mockReset();
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.removeAttribute("open");
  };
  window.matchMedia = vi.fn().mockReturnValue({
    matches: true,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }) as never;
});

describe("the … menu", () => {
  it("has an accessible name and the actions that make sense", () => {
    board();
    openMenu();
    expect(screen.getAllByRole("menuitem").map((i) => i.textContent)).toEqual([
      "Renombrar",
      "Mover a Espacio",
      "Fijar",
      "Archivar",
      "Eliminar",
    ]);
  });

  it("filed in a Space: it also offers to take it out", () => {
    board({ primary: GENERAL });
    openMenu();
    expect(screen.getByRole("menuitem", { name: "Quitar del Espacio" })).toBeTruthy();
  });

  it("voice sessions: no archive (archiving one forgets it); archived ones can be restored", () => {
    board({ voice: true });
    openMenu();
    expect(screen.queryByRole("menuitem", { name: "Archivar" })).toBeNull();
  });

  it("Mover a Espacio lists Spaces with their own glyphs, and moves optimistically", async () => {
    let resolve: (v: unknown) => void = () => undefined;
    actions.moveThreadAction.mockReturnValue(new Promise((r) => (resolve = r)));
    board();
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Mover a Espacio" }));
    const dialog = screen
      .getByRole("heading", { name: "Mover conversación a Espacio" })
      .closest("dialog")!;
    const options = within(dialog)
      .getAllByRole("button")
      .filter((b) => b.textContent);
    expect(options.map((b) => b.textContent)).toEqual(
      expect.arrayContaining(["General", "Firbot Marketing"]),
    );
    expect(dialog.querySelectorAll("svg").length).toBeGreaterThanOrEqual(2);
    fireEvent.click(within(dialog).getByRole("button", { name: "Firbot Marketing" }));
    // Gone from "Sin Espacio" at once, before the server answers.
    expect(screen.queryByText("Ajuste de un timer")).toBeNull();
    expect(actions.moveThreadAction).toHaveBeenCalledWith(C, FIRBOT);
    await act(async () => resolve({ ok: true }));
    expect(nav.refresh).toHaveBeenCalled();
  });

  it("a failed move rolls back and says so", async () => {
    actions.moveThreadAction.mockResolvedValue({
      ok: false,
      error: { code: "INTERNAL_ERROR", message: "" },
    });
    board();
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Mover a Espacio" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "General" }));
    });
    expect(screen.getByText("Ajuste de un timer")).toBeTruthy();
    expect(nav.refresh).not.toHaveBeenCalled();
  });

  it("rename, pin, archive and a confirmed delete use their actions", async () => {
    board();
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Renombrar" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Nombre" }), {
      target: { value: "Timer" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    });
    expect(actions.renameThreadAction).toHaveBeenCalledWith(C, "Timer");

    openMenu();
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Fijar" }));
    });
    expect(actions.pinThreadAction).toHaveBeenCalledWith(C, true);

    openMenu();
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Archivar" }));
    });
    expect(actions.archiveConversationAction).toHaveBeenCalledWith(C1, true);

    window.confirm = vi.fn().mockReturnValue(false);
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Eliminar" }));
    expect(window.confirm).toHaveBeenCalled();
    expect(actions.deleteConversationAction).not.toHaveBeenCalled();
  });

  it("phones: every action works from the menu (drag & drop only with a mouse)", () => {
    window.matchMedia = vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }) as never;
    board();
    expect(screen.getByText("Ajuste de un timer").closest("li")!.getAttribute("draggable")).toBe(
      "false",
    );
  });
});

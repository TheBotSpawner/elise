// @vitest-environment jsdom
import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PublicError } from "@/core/errors";
import { I18nProvider } from "@/lib/i18n/client";

vi.mock("@/features/chat/attachment-actions", () => ({
  stageAttachmentsAction: vi.fn(),
  completeAttachmentAction: vi.fn(),
  removeAttachmentAction: vi.fn(),
}));
vi.mock("@/features/location/shared-location", () => ({ locationForTurn: async () => null }));

const { createDraftStore } = await import("@/features/chat/draft-attachments");
const { createDragDepth, DraftAttachmentChips, FileDropZone, isFileDrag } =
  await import("@/features/chat/attachments-ui");
const { useEliseChat } = await import("@/features/chat/use-elise-chat");

// jsdom has no object URLs (thumbnails).
URL.createObjectURL = () => "blob:preview";
URL.revokeObjectURL = () => undefined;

type Transport = Parameters<typeof createDraftStore>[0];
const ERR: PublicError = {
  code: "PROVIDER_UNAVAILABLE",
  message: "",
  retryable: true,
  recovery: "retry",
  referenceId: "",
};

/** A transport whose uploads finish when the test says so. */
function fakeTransport() {
  const pending = new Map<string, (ok: boolean) => void>();
  const removed: string[] = [];
  let n = 0;
  let failNext = false;
  const transport: Transport = {
    async stage(file) {
      const id = `id-${++n}-${file.name}`;
      return { ok: true, id, path: id, token: "t", contentType: "text/plain" };
    },
    put(target) {
      return new Promise<boolean>((resolve) => pending.set(target.path, resolve));
    },
    async complete() {
      if (failNext) {
        failNext = false;
        return { ok: false, error: ERR };
      }
      return { ok: true };
    },
    remove(id) {
      removed.push(id);
    },
  };
  const flush = async () => {
    await act(async () => {
      for (let i = 0; i < 5; i++) await Promise.resolve();
    });
  };
  return {
    transport,
    removed,
    failNextComplete: () => (failNext = true),
    /** Finishes every upload in flight. */
    async finish(ok = true) {
      await flush();
      const all = [...pending.values()];
      pending.clear();
      all.forEach((r) => r(ok));
      await flush();
    },
    flush,
  };
}

const file = (name: string, body = "hola", lastModified = 1) =>
  new File([body], name, { lastModified });

describe("draft attachments", () => {
  let t: ReturnType<typeof fakeTransport>;
  let store: ReturnType<typeof createDraftStore>;
  beforeEach(() => {
    t = fakeTransport();
    store = createDraftStore(t.transport);
  });

  it("a dropped file joins the draft and uploads at once (uploading is not sending)", async () => {
    store.add([file("a.pdf")]);
    // LOCAL lasts only until the upload starts, in the same tick.
    expect(store.get().items).toMatchObject([{ name: "a.pdf", status: "uploading" }]);
    await t.finish();
    expect(store.get().items[0]!.status).toBe("ready");
  });

  it("several files keep their order; a repeated drop adds nothing", async () => {
    const files = [file("1.pdf"), file("2.png"), file("3.txt")];
    store.add(files);
    store.add(files);
    expect(store.get().items.map((a) => a.name)).toEqual(["1.pdf", "2.png", "3.txt"]);
  });

  it("unsupported and oversized files are reported; the valid ones are kept", () => {
    const big = file("big.pdf");
    Object.defineProperty(big, "size", { value: 30 * 1024 * 1024 });
    const rejected = store.add([file("ok.pdf"), file("app.exe"), big]);
    expect(rejected).toEqual([
      { name: "app.exe", problem: "unsupported" },
      { name: "big.pdf", problem: "too_large" },
    ]);
    expect(store.get().items.map((a) => a.name)).toEqual(["ok.pdf"]);
  });

  it("removing a file drops it from the draft and deletes its staged upload", async () => {
    store.add([file("a.pdf"), file("b.pdf"), file("c.pdf")]);
    await t.finish();
    const b = store.get().items[1]!;
    store.remove(b.key);
    expect(t.removed).toEqual([b.id]);
    const taken = await store.take();
    expect(taken!.map((a) => a.name)).toEqual(["a.pdf", "c.pdf"]);
  });

  it("removed while uploading: the upload is cleaned up when it lands", async () => {
    store.add([file("a.pdf")]);
    await t.flush();
    store.remove(store.get().items[0]!.key);
    await t.finish();
    expect(store.get().items).toEqual([]);
    expect(t.removed).toHaveLength(1);
  });

  it("a failed upload can be retried", async () => {
    t.failNextComplete();
    store.add([file("a.pdf")]);
    await t.finish();
    expect(store.get().items[0]).toMatchObject({ status: "failed", error: ERR });
    store.retry(store.get().items[0]!.key);
    await t.finish();
    expect(store.get().items[0]!.status).toBe("ready");
  });

  it("sending while uploading waits, then takes exactly what was shown and clears the draft", async () => {
    store.add([file("a.pdf")]);
    let taken: unknown = undefined;
    void store.take().then((x) => (taken = x));
    await t.flush();
    expect(taken).toBeUndefined();
    expect(store.get().waiting).toBe(true);
    await t.finish();
    expect(taken).toMatchObject([{ name: "a.pdf", status: "ready" }]);
    expect(store.get()).toEqual({ items: [], waiting: false });
  });

  it("a failed upload blocks the turn instead of silently dropping the file", async () => {
    t.failNextComplete();
    store.add([file("a.pdf")]);
    await t.finish();
    expect(await store.take()).toBeNull();
    expect(store.get().items).toHaveLength(1);
  });
});

describe("global drop target", () => {
  it("only external file drags count", () => {
    expect(isFileDrag(["Files"])).toBe(true);
    expect(isFileDrag(["text/plain", "text/html"])).toBe(false);
    expect(isFileDrag(undefined)).toBe(false);
  });

  it("crossing child elements doesn't flicker: one state for the whole drag", () => {
    const changes: boolean[] = [];
    const depth = createDragDepth((a) => changes.push(a));
    depth.enter(); // canvas
    depth.enter(); // orb
    depth.leave(); // left the canvas for the orb
    depth.enter(); // a Surface
    depth.leave();
    depth.enter(); // the dock
    depth.leave();
    expect(changes).toEqual([true]);
    depth.leave(); // left the window
    expect(changes).toEqual([true, false]);
    depth.reset();
    expect(changes).toEqual([true, false]);
  });

  function drag(type: string, types: string[], files: File[] = []) {
    const e = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(e, "dataTransfer", {
      value: { types, files, dropEffect: "none" },
    });
    act(() => void window.dispatchEvent(e));
    return e;
  }

  it("shows the overlay for a file drag and adds the drop to the draft", async () => {
    render(
      <I18nProvider locale="es">
        <FileDropZone />
      </I18nProvider>,
    );
    drag("dragenter", ["text/plain"]);
    expect(screen.queryByText("Soltá para adjuntar a ELISE")).toBeNull();
    drag("dragenter", ["Files"]);
    drag("dragenter", ["Files"]);
    drag("dragleave", ["Files"]);
    expect(screen.getByText("Soltá para adjuntar a ELISE")).toBeInTheDocument();
    const over = drag("dragover", ["Files"]);
    expect(over.defaultPrevented).toBe(true);
    const { draftAttachments } = await import("@/features/chat/draft-attachments");
    const add = vi.spyOn(draftAttachments, "add").mockReturnValue([]);
    const dropped = drag("drop", ["Files"], [file("a.pdf")]);
    expect(dropped.defaultPrevented).toBe(true);
    expect(add).toHaveBeenCalledWith([expect.objectContaining({ name: "a.pdf" })]);
    // Nothing was sent: the drop only fills the draft.
    add.mockRestore();
  });
});

describe("chips", () => {
  it("show the draft's files with labelled remove and retry", async () => {
    const t = fakeTransport();
    const store = createDraftStore(t.transport);
    t.failNextComplete();
    store.add([file("informe.pdf")]);
    await t.finish();
    render(
      <I18nProvider locale="es">
        <DraftAttachmentChips store={store} />
      </I18nProvider>,
    );
    expect(screen.getByText("informe.pdf")).toBeInTheDocument();
    expect(screen.getByText("No se pudo subir")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reintentar subir informe.pdf" }));
    await t.finish();
    expect(screen.getByText(/PDF ·/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Quitar informe.pdf" }));
    expect(screen.queryByText("informe.pdf")).toBeNull();
  });
});

describe("a turn with draft attachments", () => {
  const sentBody = (mock: { mock: { calls: unknown[][] } }, i: number) =>
    JSON.parse(String((mock.mock.calls[i]![1] as RequestInit).body)) as Record<string, unknown>;
  function stream(...events: object[]) {
    return new Response(events.map((e) => `${JSON.stringify(e)}\n`).join(""), { status: 200 });
  }

  it("belongs to the next turn — typed or spoken — and leaves the draft empty", async () => {
    const t = fakeTransport();
    const store = createDraftStore(t.transport);
    const fetchMock = vi.fn(async () =>
      stream({ type: "conversation", thread: { kind: "session", id: "s1" }, runId: "r" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useEliseChat({ attachments: store }));
    store.add([file("foto.png")]);
    // Spoken while the image is still uploading: the turn waits for it.
    let done: Promise<void> | undefined;
    act(() => {
      done = result.current.send("¿Qué ves acá?", {
        modality: "voice",
        voice: { durationMs: 900, language: "es" },
      });
    });
    await t.flush();
    expect(fetchMock).not.toHaveBeenCalled();
    await t.finish();
    await act(async () => void (await done));
    const body = sentBody(fetchMock, 0);
    expect(body).toMatchObject({ message: "¿Qué ves acá?", modality: "voice" });
    expect(body.attachments).toEqual(["id-1-foto.png"]);
    expect(store.get().items).toEqual([]);
    expect(result.current.messages[0]).toMatchObject({
      role: "user",
      attachments: [{ name: "foto.png" }],
    });

    // The next turn carries nothing.
    await act(async () => void (await result.current.send("gracias")));
    const next = sentBody(fetchMock, 1);
    expect(next.attachments).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it("a turn the server refused gives the files back to the draft", async () => {
    const t = fakeTransport();
    const store = createDraftStore(t.transport);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: ERR }, { status: 400 })),
    );
    const { result } = renderHook(() => useEliseChat({ attachments: store }));
    store.add([file("a.pdf")]);
    await t.finish();
    await act(async () => void (await result.current.send("Resumime esto")));
    expect(store.get().items).toMatchObject([{ name: "a.pdf", status: "ready" }]);
    expect(result.current.failedDraft?.text).toBe("Resumime esto");
    vi.unstubAllGlobals();
  });
});

describe("the paperclip", () => {
  it("still offers Knowledge, and attaching to the message uses the same draft", async () => {
    vi.doMock("@/features/knowledge/actions", () => ({
      listSpacesAction: async () => ({ ok: true, value: [{ id: "s1", path: "Trabajo" }] }),
      createSpaceAction: vi.fn(),
    }));
    vi.doMock("@/features/knowledge/upload", () => ({ uploadFiles: vi.fn() }));
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
      this.open = true;
    };
    HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
      this.open = false;
    };
    const { AttachToKnowledge } = await import("@/features/knowledge/attach-dialog");
    const { draftAttachments } = await import("@/features/chat/draft-attachments");
    const add = vi.spyOn(draftAttachments, "add").mockReturnValue([]);
    const { container } = render(
      <I18nProvider locale="es">
        <AttachToKnowledge />
      </I18nProvider>,
    );
    expect(screen.getByRole("button", { name: "Adjuntar un archivo" })).toBeInTheDocument();
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    expect(input.accept).toContain(".png");
    const pdf = file("plan.pdf");
    await act(async () => void fireEvent.change(input, { target: { files: [pdf] } }));
    expect(await screen.findByText("Sumarlo al Conocimiento")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Adjuntar a este mensaje"));
    expect(add).toHaveBeenCalledWith([pdf]);
    add.mockRestore();
  });
});

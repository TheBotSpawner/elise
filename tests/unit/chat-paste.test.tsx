// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "@/lib/i18n/client";

vi.mock("@/features/chat/attachment-actions", () => ({
  stageAttachmentsAction: vi.fn(async () => ({ ok: false, error: { code: "INTERNAL_ERROR" } })),
  completeAttachmentAction: vi.fn(),
  removeAttachmentAction: vi.fn(),
}));
vi.mock("@/features/knowledge/attach-dialog", () => ({ AttachToKnowledge: () => null }));

const { Composer } = await import("@/features/chat/composer");
const { clipboardImages, SentAttachments } = await import("@/features/chat/attachments-ui");
const { draftAttachments } = await import("@/features/chat/draft-attachments");

URL.createObjectURL = () => "blob:preview";
URL.revokeObjectURL = () => undefined;

/** A ClipboardEvent's data as browsers expose it: items (kind/type/getAsFile), files, types. */
function clipboard(entries: ({ text: string } | { file: File })[]) {
  const files = entries.flatMap((e) => ("file" in e ? [e.file] : []));
  const text = entries.find((e): e is { text: string } => "text" in e)?.text;
  return {
    items: entries.map((e) =>
      "file" in e
        ? { kind: "file", type: e.file.type, getAsFile: () => e.file }
        : { kind: "string", type: "text/plain", getAsFile: () => null },
    ),
    files,
    types: [...(text !== undefined ? ["text/plain"] : []), ...(files.length ? ["Files"] : [])],
    getData: (t: string) => (t === "text/plain" ? (text ?? "") : ""),
  } as unknown as DataTransfer;
}

const png = () =>
  new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "image.png", { type: "image/png" });
const jpeg = () =>
  new File([new Uint8Array([0xff, 0xd8, 0xff])], "image.jpg", { type: "image/jpeg" });

function composer() {
  render(
    <I18nProvider locale="es">
      <Composer
        placeholder="Preguntale a ELISE"
        label="Mensaje"
        busy={false}
        onSend={() => {}}
        onStop={() => {}}
        sendLabel="Enviar"
        stopLabel="Parar"
      />
    </I18nProvider>,
  );
  return screen.getByLabelText("Mensaje") as HTMLTextAreaElement;
}

beforeEach(() => {
  draftAttachments.clear();
  vi.restoreAllMocks();
});

describe("clipboard images", () => {
  it("PNG and JPEG become named files for the draft (each paste a distinct name)", () => {
    const at = new Date("2026-10-14T18:08:28Z");
    const [a] = clipboardImages(clipboard([{ file: png() }]), at);
    const [b] = clipboardImages(clipboard([{ file: jpeg() }]), at);
    expect(a).toMatchObject({ name: "pegada-20261014-180828.png", type: "image/png" });
    expect(b).toMatchObject({ name: "pegada-20261014-180828.jpg", type: "image/jpeg" });
    const many = clipboardImages(clipboard([{ file: png() }, { file: png() }]), at);
    expect(many.map((f) => f.name)).toEqual([
      "pegada-20261014-180828-1.png",
      "pegada-20261014-180828-2.png",
    ]);
  });

  it("text-only clipboards and non-image files yield nothing", () => {
    expect(clipboardImages(clipboard([{ text: "hola" }]))).toEqual([]);
    expect(
      clipboardImages(clipboard([{ file: new File(["x"], "a.pdf", { type: "application/pdf" }) }])),
    ).toEqual([]);
    expect(clipboardImages(null)).toEqual([]);
  });
});

describe("CTRL/CMD+V in the composer", () => {
  it("a pasted image joins the same draft as the picker, with a preview chip", () => {
    const add = vi.spyOn(draftAttachments, "add");
    const input = composer();
    const event = fireEvent.paste(input, { clipboardData: clipboard([{ file: png() }]) });
    expect(add).toHaveBeenCalledTimes(1);
    expect(add.mock.calls[0]![0]![0]).toMatchObject({ type: "image/png" });
    expect(draftAttachments.get().items[0]).toMatchObject({
      kind: "image",
      preview: "blob:preview",
    });
    // Image only: nothing to paste as text.
    expect(event).toBe(false);
  });

  it("a JPEG paste works the same way, and can be removed before sending", () => {
    const input = composer();
    fireEvent.paste(input, { clipboardData: clipboard([{ file: jpeg() }]) });
    const [item] = draftAttachments.get().items;
    expect(item).toMatchObject({ mimeType: "image/jpeg" });
    draftAttachments.remove(item!.key);
    expect(draftAttachments.get().items).toHaveLength(0);
  });

  it("plain text pastes normally (not intercepted, no attachment)", () => {
    const add = vi.spyOn(draftAttachments, "add");
    const input = composer();
    const event = fireEvent.paste(input, { clipboardData: clipboard([{ text: "hola" }]) });
    expect(event).toBe(true); // default not prevented: the browser inserts the text
    expect(add).not.toHaveBeenCalled();
  });

  it("image + text: the image is attached and the text still pastes", () => {
    const input = composer();
    const event = fireEvent.paste(input, {
      clipboardData: clipboard([{ text: "Learning Paths" }, { file: png() }]),
    });
    expect(event).toBe(true);
    expect(draftAttachments.get().items).toHaveLength(1);
  });
});

describe("sent images in the transcript", () => {
  it("show as thumbnails served to their author (they survive reloads) and open larger", () => {
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    };
    HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
      this.removeAttribute("open");
    };
    render(
      <I18nProvider locale="es">
        <SentAttachments
          files={[
            {
              id: "11111111-1111-4111-8111-111111111111",
              name: "Learning Paths.jpg",
              mimeType: "image/jpeg",
              size: 1,
            },
            {
              id: "22222222-2222-4222-8222-222222222222",
              name: "plan.pdf",
              mimeType: "application/pdf",
              size: 1,
            },
          ]}
        />
      </I18nProvider>,
    );
    const thumb = screen.getByRole("img", { name: "Learning Paths.jpg" });
    expect(thumb.getAttribute("src")).toBe("/api/attachments/11111111-1111-4111-8111-111111111111");
    expect(screen.getByText("plan.pdf")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Ver Learning Paths.jpg" }));
    expect(screen.getAllByRole("img", { name: "Learning Paths.jpg" })).toHaveLength(2);
  });
});

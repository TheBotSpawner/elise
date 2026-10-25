import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { chatAttachmentPath, financeImportPath, originalPath } =
  await import("@/infrastructure/supabase/storage");

/** A real file name with dots ("Programa A. de S..png") must upload, never look like "..". */
describe("upload paths", () => {
  it("a run of dots becomes one, a leading dot goes; the path never contains ..", () => {
    const ws = "710c5b4b-9667-4d6d-a73a-14f32b082c3c";
    const p = originalPath(ws, "item", "version", "Programa A. de S..png");
    expect(p).toBe(`workspace/${ws}/knowledge/item/version/Programa_A._de_S.png`);
    expect(originalPath(ws, "i", "v", "../../etc/passwd")).not.toContain("..");
    expect(originalPath(ws, "i", "v", ".env")).toMatch(/\/env$/);
    expect(chatAttachmentPath(ws, "a", "Foto.. final..jpg")).not.toContain("..");
    expect(financeImportPath(ws, "i", "Resumen..xlsx")).not.toContain("..");
  });
});

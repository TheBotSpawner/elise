// @vitest-environment jsdom
import { Markdown } from "@tiptap/markdown";
import { Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { describe, expect, it } from "vitest";

import { executeToolCall } from "@/core/agents/executor";
import type { ProviderFactory } from "@/core/agents/tools";
import {
  nextSpaces,
  plainText,
  type Note,
  type NoteTag,
  type NotesProvider,
} from "@/core/capabilities/notes";

import { binding, makeCtx, makePorts, NATIVE_BINDING } from "../../fixtures/core-fakes";

/** The editor exactly as the Notes screen configures it, outside React. */
function roundTrip(markdown: string) {
  const editor = new Editor({
    extensions: [StarterKit, Markdown],
    content: markdown,
    contentType: "markdown",
  });
  const out = editor.getMarkdown();
  editor.destroy();
  return out;
}

describe("note content is Markdown (ADR-056)", () => {
  it("keeps formatting through the editor: headings, bold, italic, lists, quote, code, link", () => {
    const md = [
      "# Reunión",
      "",
      "**Decisiones**",
      "",
      "- Primera",
      "- Segunda",
      "",
      "1. Uno",
      "2. Dos",
      "",
      "*Comentario*",
      "",
      "> Una cita",
      "",
      "Usar `npm run build` y [la guía](https://elise.test/guia).",
      "",
      "```",
      "const a = 1;",
      "```",
    ].join("\n");
    const out = roundTrip(md);
    for (const token of [
      "# Reunión",
      "**Decisiones**",
      "- Primera",
      "- Segunda",
      "1. Uno",
      "*Comentario*",
      "> Una cita",
      "`npm run build`",
      "[la guía](https://elise.test/guia)",
      "const a = 1;",
    ])
      expect(out).toContain(token);
    // Stable: saving again without edits changes nothing.
    expect(roundTrip(out)).toBe(out);
  });

  it("opens legacy plain-text notes without losing a word", () => {
    const legacy = "Llamar a Ana el lunes\nRevisar presupuesto 2027\n\nIdeas: precios, plazos";
    const out = roundTrip(legacy);
    for (const word of [
      "Llamar a Ana el lunes",
      "Revisar presupuesto 2027",
      "Ideas: precios, plazos",
    ])
      expect(out).toContain(word);
  });

  it("previews and search read text, never Markdown syntax", () => {
    expect(
      plainText("# Reunión\n\n**Propuesta comercial**\n\n- Primera\n> cita\n[web](https://x.y)"),
    ).toBe("Reunión Propuesta comercial Primera cita web");
    expect(plainText("Usá `código` e *itálica*.")).toBe("Usá código e itálica.");
  });
});

describe("one note, many Spaces", () => {
  it("adds, removes and replaces without duplicates", () => {
    expect(nextSpaces(["a"], { add: ["b", "a"] })).toEqual(["a", "b"]);
    expect(nextSpaces(["a", "b"], { remove: ["b"] })).toEqual(["a"]);
    expect(nextSpaces(["a", "b"], { spaces: [] })).toEqual([]);
    expect(nextSpaces(["a"], { spaces: ["c", "c"], add: ["d"] })).toEqual(["c", "d"]);
  });
});

// ── Tools through the executor ───────────────────────────────────────────────

const SPACES = [
  { id: "gk", path: "General Knowledge" },
  { id: "fs", path: "Firbot Solutions" },
  { id: "fm", path: "Firbot Marketing" },
];

class MemoryNotes implements NotesProvider {
  notes: Note[] = [];
  writes = 0;
  private shape(n: Omit<Note, "spaces" | "spaceId" | "spaceName"> & { spaceIds: string[] }): Note {
    const spaces = n.spaceIds.map((id) => SPACES.find((s) => s.id === id)!);
    return { ...n, spaces, spaceId: spaces[0]?.id ?? null, spaceName: spaces[0]?.path ?? null };
  }
  async list() {
    return this.notes;
  }
  async find(ref: string) {
    return this.notes.filter(
      (n) => n.id === ref || n.title.toLowerCase().includes(ref.toLowerCase()),
    );
  }
  async get(id: string) {
    return this.notes.find((n) => n.id === id) ?? null;
  }
  async search() {
    return this.notes;
  }
  async create(n: { title: string; content: string; spaceIds: string[] }) {
    const note = this.shape({
      ...n,
      id: `n${this.notes.length + 1}`,
      source: "ai",
      createdAt: "",
      updatedAt: "",
    });
    this.notes.push(note);
    this.writes++;
    return note;
  }
  async update(id: string, p: { title?: string; content?: string; spaceIds?: string[] }) {
    const i = this.notes.findIndex((n) => n.id === id);
    const cur = this.notes[i]!;
    this.notes[i] = this.shape({
      ...cur,
      ...(p.title !== undefined ? { title: p.title } : {}),
      ...(p.content !== undefined ? { content: p.content } : {}),
      spaceIds: p.spaceIds ?? cur.spaces.map((s) => s.id),
    });
    this.writes++;
    return this.notes[i]!;
  }
  async archive(id: string) {
    return this.notes.find((n) => n.id === id)!;
  }
  async resolveSpace(ref: string) {
    const r = ref.toLowerCase();
    const found = SPACES.filter((s) => s.path.toLowerCase().includes(r));
    return found.length === 1 ? found[0]! : null;
  }
  // ADR-088
  tags: NoteTag[] = [];
  async listTags() {
    return this.tags;
  }
  async saveTag(t: { id?: string; name?: string; color?: NoteTag["color"] }) {
    if (t.id) {
      const cur = this.tags.find((x) => x.id === t.id)!;
      Object.assign(cur, {
        ...(t.name ? { name: t.name } : {}),
        ...(t.color ? { color: t.color } : {}),
      });
      for (const n of this.notes) n.tags = n.tags?.map((x) => (x.id === cur.id ? { ...cur } : x));
      return cur;
    }
    const made = { id: `t${this.tags.length + 1}`, name: t.name!, color: t.color ?? "gray" };
    this.tags.push(made);
    return made;
  }
  async deleteTag(id: string) {
    this.tags = this.tags.filter((x) => x.id !== id);
    for (const n of this.notes) n.tags = n.tags?.filter((x) => x.id !== id);
  }
  async setNoteTags(noteId: string, tagIds: string[]) {
    const n = this.notes.find((x) => x.id === noteId)!;
    n.tags = tagIds.map((id) => this.tags.find((x) => x.id === id)!);
    return n;
  }
}

function notePorts() {
  const notes = new MemoryNotes();
  const { ports } = makePorts([
    NATIVE_BINDING,
    binding({
      connectionId: "conn-native",
      capability: "notes",
      providerKey: "elise_native",
      label: "ELISE",
      isDefault: true,
    }),
  ]);
  ports.providers = { get: (() => notes) as ProviderFactory["get"] };
  return { ports, notes };
}

describe("note tags (ADR-088)", () => {
  const ctx = makeCtx();
  const run = async (ports: ReturnType<typeof notePorts>["ports"], name: string, args: unknown) => {
    const out = await executeToolCall(ports, ctx, { name, args });
    if (out.status !== "succeeded") throw new Error(JSON.stringify(out));
    return out;
  };

  it("“Etiquetala como Ideas y Urgente” tags the note, creating the missing tags once", async () => {
    const { ports, notes } = notePorts();
    await run(ports, "notes.create", { title: "Plan Q4", content: "" });
    await run(ports, "notes.saveTag", { name: "Ideas", color: "blue" });
    await run(ports, "notes.tag", { note: "Plan Q4", add: ["ideas", "Urgente"] });
    expect(notes.tags.map((t) => t.name)).toEqual(["Ideas", "Urgente"]);
    expect(notes.notes[0]!.tags?.map((t) => t.name)).toEqual(["Ideas", "Urgente"]);
    await run(ports, "notes.tag", { note: "Plan Q4", remove: ["Urgente"] });
    expect(notes.notes[0]!.tags?.map((t) => t.name)).toEqual(["Ideas"]);
  });

  it("rename and recolor a tag; deleting it keeps the note", async () => {
    const { ports, notes } = notePorts();
    await run(ports, "notes.create", { title: "Receta", content: "" });
    await run(ports, "notes.tag", { note: "Receta", tags: ["Cocina"] });
    await run(ports, "notes.saveTag", { tag: "cocina", name: "Cocina casera", color: "green" });
    expect(notes.tags[0]).toMatchObject({ name: "Cocina casera", color: "green" });
    await run(ports, "notes.deleteTag", { tag: "Cocina casera" });
    expect(notes.tags).toEqual([]);
    expect(notes.notes).toHaveLength(1);
    expect(notes.notes[0]!.tags).toEqual([]);
  });

  it("filtering by an unknown tag asks instead of guessing", async () => {
    const { ports } = notePorts();
    const out = await executeToolCall(ports, ctx, {
      name: "notes.list",
      args: { tags: ["Nada"] },
    });
    expect(out.status).toBe("failed");
  });
});

describe("notes tools (chat)", () => {
  const ctx = makeCtx();

  it("“Creá una nota y guardala en General Knowledge y Firbot Solutions” → ONE note in two Spaces", async () => {
    const { ports, notes } = notePorts();
    const out = await executeToolCall(ports, ctx, {
      name: "notes.create",
      args: {
        title: "Proceso de propuestas",
        content: "## Pasos\n\n- Brief\n- **Propuesta**",
        spaces: ["General Knowledge", "Firbot Solutions"],
      },
    });
    expect(out.status).toBe("succeeded");
    expect(notes.notes).toHaveLength(1);
    expect(notes.notes[0]!.spaces.map((s) => s.id)).toEqual(["gk", "fs"]);
  });

  it("add, remove, outside Knowledge — the note itself is never deleted", async () => {
    const { ports, notes } = notePorts();
    await executeToolCall(ports, ctx, {
      name: "notes.create",
      args: { title: "Proceso comercial", spaces: ["Firbot Solutions"] },
    });
    await executeToolCall(ports, ctx, {
      name: "notes.setKnowledgeSpaces",
      args: { note: "comercial", add: ["Marketing"] },
    });
    expect(notes.notes[0]!.spaces.map((s) => s.id)).toEqual(["fs", "fm"]);
    await executeToolCall(ports, ctx, {
      name: "notes.setKnowledgeSpaces",
      args: { note: "comercial", remove: ["Marketing"] },
    });
    expect(notes.notes[0]!.spaces.map((s) => s.id)).toEqual(["fs"]);
    await executeToolCall(ports, ctx, {
      name: "notes.setKnowledgeSpaces",
      args: { note: "comercial", spaces: [] },
    });
    expect(notes.notes).toHaveLength(1);
    expect(notes.notes[0]!.spaces).toEqual([]);
  });

  it("rejects unknown Spaces and empty changes instead of guessing", async () => {
    const { ports, notes } = notePorts();
    await executeToolCall(ports, ctx, { name: "notes.create", args: { title: "X" } });
    const unknown = await executeToolCall(ports, ctx, {
      name: "notes.setKnowledgeSpaces",
      args: { note: "X", add: ["Inexistente"] },
    });
    expect(unknown.status).toBe("failed");
    const empty = await executeToolCall(ports, ctx, {
      name: "notes.setKnowledgeSpaces",
      args: { note: "X" },
    });
    expect(empty.status).not.toBe("succeeded");
    expect(notes.notes[0]!.spaces).toEqual([]);
  });

  it("editing content keeps its Spaces", async () => {
    const { ports, notes } = notePorts();
    await executeToolCall(ports, ctx, {
      name: "notes.create",
      args: {
        title: "Kickoff",
        content: "Ideas",
        spaces: ["Firbot Solutions", "Firbot Marketing"],
      },
    });
    await executeToolCall(ports, ctx, {
      name: "notes.update",
      args: { note: "Kickoff", content: "## Conclusiones\n\n**Decidimos** avanzar." },
    });
    expect(notes.notes[0]).toMatchObject({ content: "## Conclusiones\n\n**Decidimos** avanzar." });
    expect(notes.notes[0]!.spaces.map((s) => s.id)).toEqual(["fs", "fm"]);
  });
});

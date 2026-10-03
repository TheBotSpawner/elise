import { describe, expect, it } from "vitest";

import { historyFolders, locationOf, primaryLink, type KnowledgeNode } from "@/core/history/links";

/** History as folders: Space › Section › conversations, each filed once. Synthetic names. */

const node = (id: string, name: string, parent?: KnowledgeNode): KnowledgeNode => ({
  id,
  name,
  parentId: parent?.id ?? null,
  parentName: parent?.name ?? null,
  archived: false,
});
const uni = node("s1", "Uni");
const calc = node("c1", "Calculus", uni);
const law = node("c2", "Law", uni);
const work = node("s2", "Work");
const nodes = new Map([uni, calc, law, work].map((n) => [n.id, n]));

const link = (
  spaceId: string,
  source: "manual" | "automatic",
  confidence: number | null,
  updatedAt = "2026-10-01T00:00:00Z",
) => ({ spaceId, source, confidence, updatedAt });

describe("primary link (where a conversation is filed)", () => {
  it("the user's choice wins over ELISE's, then confidence, then the more specific", () => {
    expect(primaryLink([link("s2", "automatic", 0.95), link("c1", "manual", null)], nodes)).toBe(
      "c1",
    );
    expect(primaryLink([link("c1", "automatic", 0.75), link("s2", "automatic", 0.9)], nodes)).toBe(
      "s2",
    );
    expect(primaryLink([link("s1", "automatic", 0.8), link("c1", "automatic", 0.8)], nodes)).toBe(
      "c1",
    );
  });

  it("is deterministic and ignores links to unknown nodes", () => {
    const a = link("c1", "automatic", 0.8, "2026-09-01T00:00:00Z");
    const b = link("c2", "automatic", 0.8, "2026-09-05T00:00:00Z");
    expect(primaryLink([b, a], nodes)).toBe("c1");
    expect(primaryLink([a, b], nodes)).toBe("c1");
    expect(primaryLink([link("gone", "manual", null)], nodes)).toBeNull();
  });
});

describe("folder tree", () => {
  const row = (key: string, primary: string | null, at: string) => ({ key, primary, at });
  const rows = [
    row("a", "c1", "2026-10-02T15:00:00Z"),
    row("b", "s2", "2026-10-01T09:00:00Z"),
    row("c", "c2", "2026-09-20T09:00:00Z"),
    row("d", "s1", "2026-09-10T09:00:00Z"),
    row("e", null, "2026-10-02T10:00:00Z"),
    row("f", "c1", "2026-09-30T09:00:00Z"),
  ];

  it("Space › Section › conversations, plus 'Sin Espacio'; each conversation once", () => {
    const tree = historyFolders(rows, nodes);
    expect(tree.spaces.map((s) => [s.label, s.count])).toEqual([
      ["Uni", 4],
      ["Work", 1],
    ]);
    const u = tree.spaces[0]!;
    expect(u.sections.map((s) => [s.label, s.items.map((i) => i.key)])).toEqual([
      ["Calculus", ["a", "f"]],
      ["Law", ["c"]],
    ]);
    expect(u.general.map((i) => i.key)).toEqual(["d"]);
    expect(tree.untagged.map((i) => i.key)).toEqual(["e"]);
    const all = [
      ...tree.spaces.flatMap((s) => [...s.general, ...s.sections.flatMap((x) => x.items)]),
      ...tree.untagged,
    ];
    expect(all).toHaveLength(rows.length);
  });

  it("orders Spaces and Sections by their most recent conversation", () => {
    const later = [
      ...rows,
      row("g", "c2", "2026-10-03T08:00:00Z"),
      row("h", "s2", "2026-10-04T08:00:00Z"),
    ];
    const tree = historyFolders(later, nodes);
    expect(tree.spaces.map((s) => s.label)).toEqual(["Work", "Uni"]);
    expect(tree.spaces[1]!.sections.map((s) => s.label)).toEqual(["Law", "Calculus"]);
  });

  it("search results say where they are filed", () => {
    expect(locationOf("c1", nodes)).toBe("Uni › Calculus");
    expect(locationOf("s2", nodes)).toBe("Work");
    expect(locationOf(null, nodes)).toBeNull();
  });
});

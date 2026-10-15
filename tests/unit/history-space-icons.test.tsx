// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { KnowledgeNode } from "@/core/history/links";
import { HistoryControls, type HistoryParams } from "@/features/history/history-controls";
import { HistoryFolder } from "@/features/history/history-folder";
import { NoSpaceGlyph, SpaceGlyph, SPACE_HEX } from "@/features/knowledge/appearance";
import { I18nProvider } from "@/lib/i18n/client";

/**
 * History shows each Space with the same glyph and accent it has in Knowledge (read from the
 * Space, never hardcoded by name); "Sin Espacio" gets a neutral glyph; a Space with no look yet
 * falls back to the default.
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

const node = (
  over: Partial<KnowledgeNode> & Pick<KnowledgeNode, "id" | "name">,
): KnowledgeNode => ({
  parentId: null,
  parentName: null,
  archived: false,
  ...over,
});

const params: HistoryParams = { q: "", space: null, section: null, group: "space", sort: "newest" };

function chips(nodes: KnowledgeNode[]) {
  return render(
    <I18nProvider locale="es">
      <HistoryControls params={params} nodes={nodes} />
    </I18nProvider>,
  );
}

const glyphOf = (el: HTMLElement) => el.querySelector("span[aria-hidden]") as HTMLElement | null;
const svgClass = (el: HTMLElement | null) => el?.querySelector("svg")?.getAttribute("class") ?? "";

describe("History Space icons", () => {
  it("each Space chip carries its own Knowledge icon and accent; Sin Espacio is neutral", () => {
    chips([
      node({ id: "u", name: "UTN", icon: "graduation", color: "blue" }),
      node({ id: "f", name: "Firbot Solutions", icon: "code", color: "violet" }),
      node({ id: "g", name: "General", icon: "sparkles", color: "teal" }),
      node({ id: "old", name: "Espacio viejo" }),
    ]);
    const utn = glyphOf(screen.getByRole("link", { name: "UTN" }))!;
    expect(svgClass(utn)).toMatch(/graduation-cap/);
    expect(utn.style.color).toBe(hexToRgb(SPACE_HEX.blue));
    expect(svgClass(glyphOf(screen.getByRole("link", { name: "Firbot Solutions" })))).toMatch(
      /code/,
    );
    expect(svgClass(glyphOf(screen.getByRole("link", { name: "General" })))).toMatch(/sparkles/);
    // No look stored yet: the same default Knowledge uses.
    const fallback = render(<SpaceGlyph icon={null} color={null} size="xs" />).container;
    expect(svgClass(glyphOf(screen.getByRole("link", { name: "Espacio viejo" })))).toBe(
      svgClass(fallback as HTMLElement),
    );
    const none = glyphOf(screen.getByRole("link", { name: "Sin Espacio" }))!;
    expect(svgClass(none)).toMatch(/message/);
    expect(none.getAttribute("style")).toBeNull();
  });

  it("a changed icon in Knowledge is what History shows (nothing cached by name)", () => {
    const { unmount } = chips([node({ id: "u", name: "UTN", icon: "graduation", color: "blue" })]);
    unmount();
    chips([node({ id: "u", name: "UTN", icon: "rocket", color: "orange" })]);
    expect(svgClass(glyphOf(screen.getByRole("link", { name: "UTN" })))).toMatch(/rocket/);
  });

  it("folders show the glyph before the name, at the row's size", () => {
    render(
      <HistoryFolder
        id="space:u"
        label="UTN"
        count={3}
        icon={<SpaceGlyph icon="graduation" color="blue" size="sm" />}
      >
        <p>x</p>
      </HistoryFolder>,
    );
    const row = screen.getByRole("button", { name: /UTN/ });
    expect(svgClass(row.querySelector("span[aria-hidden]") as HTMLElement)).toMatch(
      /graduation-cap/,
    );
    render(
      <HistoryFolder id="untagged" label="Sin Espacio" count={1} icon={<NoSpaceGlyph />}>
        <p>y</p>
      </HistoryFolder>,
    );
    expect(screen.getByRole("button", { name: /Sin Espacio/ }).querySelector("svg")).not.toBeNull();
  });
});

function hexToRgb(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

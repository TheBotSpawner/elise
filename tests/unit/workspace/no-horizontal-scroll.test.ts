import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * ADR-135: a widget adapts to its card; it never scrolls sideways. The Temporal view and the shelf
 * of chips are whole-canvas strips, not widgets.
 */
const ROOT = join(__dirname, "../../../src/features/workspace");
const STRIPS = new Set(["temporal-view.tsx", "live-canvas.tsx"]);
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? files(join(dir, e.name))
      : e.name.endsWith(".tsx") && !STRIPS.has(e.name)
        ? [join(dir, e.name)]
        : [],
  );

describe("widgets", () => {
  it("never scroll sideways", () => {
    const offenders = files(ROOT).filter((f) =>
      /overflow-x-(auto|scroll)/.test(readFileSync(f, "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});

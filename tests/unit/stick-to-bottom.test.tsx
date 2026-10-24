// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { useRef } from "react";
import { describe, expect, it, vi } from "vitest";

import { useStickToBottom } from "@/features/chat/use-stick-to-bottom";

/**
 * The transcript follows new replies only while the person is at the bottom; scrolled up to
 * read, it stays put until they come back down.
 */

let grow: () => void = () => {};
vi.stubGlobal(
  "ResizeObserver",
  class {
    constructor(cb: () => void) {
      grow = cb;
    }
    observe() {}
    disconnect() {}
  },
);

function Box({ onBox }: { onBox: (el: HTMLDivElement) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  useStickToBottom(box, inner);
  return (
    <div
      ref={(el) => {
        if (el) onBox(el);
        box.current = el;
      }}
    >
      <div ref={inner} />
    </div>
  );
}

function scrollable(el: HTMLDivElement, height: number) {
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => height });
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => 400 });
  el.scrollTo = ((opts: ScrollToOptions) => {
    el.scrollTop = opts.top ?? 0;
  }) as typeof el.scrollTo;
}

describe("stick to bottom", () => {
  it("at the bottom it follows; scrolled up it stays; back down it follows again", () => {
    let el!: HTMLDivElement;
    render(
      <Box
        onBox={(b) => {
          el = b;
          scrollable(b, 1000);
        }}
      />,
    );
    // Content grows while at the bottom: it follows.
    scrollable(el, 1000);
    el.scrollTop = 600;
    el.dispatchEvent(new Event("scroll"));
    scrollable(el, 1400);
    grow();
    expect(el.scrollTop).toBe(1400);
    // The person scrolls up to read: new content doesn't move them.
    el.scrollTop = 200;
    el.dispatchEvent(new Event("scroll"));
    scrollable(el, 1800);
    grow();
    expect(el.scrollTop).toBe(200);
    // Back at the bottom: following again.
    el.scrollTop = 1400;
    el.dispatchEvent(new Event("scroll"));
    scrollable(el, 2200);
    grow();
    expect(el.scrollTop).toBe(2200);
  });
});

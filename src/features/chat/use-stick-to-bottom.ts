"use client";

import { useEffect, type RefObject } from "react";

/** Within this distance of the end counts as "at the bottom" (a few pixels of rounding). */
const NEAR_PX = 48;

/**
 * A conversation that follows new replies only while the person is at the bottom: content that
 * grows (a streamed answer, steps, a widget) keeps it at the end; once they scroll up to read,
 * it stays where they left it until they come back down. `scroller` is the scrolling element,
 * or null for the page itself; `content` is what grows.
 */
export function useStickToBottom(
  scroller: RefObject<HTMLElement | null> | null,
  content: RefObject<HTMLElement | null>,
  active = true,
) {
  useEffect(() => {
    if (!active) return;
    const box = scroller?.current ?? null;
    const target = content.current;
    if (!target || (scroller && !box)) return;
    const metrics = () =>
      box
        ? { top: box.scrollTop, height: box.scrollHeight, view: box.clientHeight }
        : {
            top: window.scrollY,
            height: document.documentElement.scrollHeight,
            view: window.innerHeight,
          };
    const toEnd = () => {
      const m = metrics();
      if (box) box.scrollTo({ top: m.height });
      else window.scrollTo({ top: m.height });
    };
    let pinned = true;
    const onScroll = () => {
      const m = metrics();
      pinned = m.height - m.top - m.view < NEAR_PX;
    };
    toEnd();
    const source: HTMLElement | Window = box ?? window;
    source.addEventListener("scroll", onScroll, { passive: true });
    const grow = new ResizeObserver(() => {
      if (pinned) toEnd();
    });
    grow.observe(target);
    return () => {
      source.removeEventListener("scroll", onScroll);
      grow.disconnect();
    };
  }, [scroller, content, active]);
}

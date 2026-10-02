"use client";

import { useEffect, useState, type RefObject } from "react";

/** An element's content box, kept current with a ResizeObserver (0 × 0 before mount). */
export function useElementSize(ref: RefObject<HTMLElement | null>) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const { width, height } = entry.contentRect;
      setSize((s) =>
        Math.round(s.width) === Math.round(width) && Math.round(s.height) === Math.round(height)
          ? s
          : { width, height },
      );
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

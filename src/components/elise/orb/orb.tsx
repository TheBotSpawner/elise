"use client";

import { useEffect, useRef } from "react";

import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

import { OrbRenderer } from "./orb-renderer";
import { toRendererState, type OrbState } from "./orb-states";

/**
 * The ELISE Orb: one <canvas>, one requestAnimationFrame loop, DPR capped at 2.
 * Paused while the document is hidden or the orb is off-screen. Leans toward the pointer.
 * Honours prefers-reduced-motion (no rotation/deformation/tremor; state via colour, rings, halo).
 */
export function Orb({
  state = "idle",
  size = 160,
  level = -1,
  className,
}: {
  state?: OrbState;
  /** Pixel size, or "fill" to size by CSS (className must set a square size, e.g. size-[300px]). */
  size?: number | "fill";
  /** Live audio level 0..1 while listening/speaking; negative = simulated. */
  level?: number;
  className?: string;
}) {
  const { t } = useI18n();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const input = useRef({ state, size, level });

  useEffect(() => {
    input.current = { state, size, level };
  }, [state, size, level]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const renderer = new OrbRenderer();
    const pointer = { x: 0, y: 0 };
    const reducedQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    let visible = true;
    let raf = 0;

    const onMove = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      if (!r.width) return;
      const nx = ((e.clientX - r.left) / r.width - 0.5) * 2;
      const ny = ((e.clientY - r.top) / r.height - 0.5) * 2;
      pointer.x = nx / (1 + Math.abs(nx));
      pointer.y = ny / (1 + Math.abs(ny));
    };
    window.addEventListener("pointermove", onMove, { passive: true });

    const observer = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? true;
    });
    observer.observe(canvas);

    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      if (!visible || document.hidden) return;
      const { state: s, size, level: lv } = input.current;
      const px = size === "fill" ? canvas.clientWidth : size;
      if (!px) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const backing = Math.round(px * dpr);
      if (canvas.width !== backing || canvas.height !== backing) {
        canvas.width = backing;
        canvas.height = backing;
      }
      renderer.frame(ctx, px, dpr, now, {
        state: toRendererState(s),
        light: !document.documentElement.classList.contains("dark"),
        reduced: reducedQuery.matches,
        level: lv,
        pointer,
      });
    };
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      window.removeEventListener("pointermove", onMove);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      role="img"
      aria-label={t.orb[state]}
      className={cn("block shrink-0", className)}
      style={size === "fill" ? undefined : { width: size, height: size }}
    />
  );
}

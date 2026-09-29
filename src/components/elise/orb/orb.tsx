"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState, type PointerEvent } from "react";

import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

import { ORB_STYLES, type OrbState } from "./orb-states";

const BLOB_SHAPES = [
  "46% 54% 52% 48% / 50% 46% 54% 50%",
  "54% 46% 44% 56% / 46% 56% 44% 54%",
  "50% 50% 56% 44% / 56% 48% 52% 44%",
  "46% 54% 52% 48% / 50% 46% 54% 50%",
];

interface Ripple {
  id: number;
  x: number;
  y: number;
}

/**
 * The ELISE Orb: an abstract, wave-based presence. Its motion expresses Elise's state.
 * Pointer movement nearby sends small ripples toward the cursor.
 */
export function Orb({
  state = "idle",
  size = 160,
  className,
}: {
  state?: OrbState;
  size?: number;
  className?: string;
}) {
  const { t } = useI18n();
  const reduceMotion = useReducedMotion() ?? false;
  const style = ORB_STYLES[state];
  const [waves, setWaves] = useState<number[]>([]);
  const [ripples, setRipples] = useState<Ripple[]>([]);
  const lastRipple = useRef(0);
  const counter = useRef(0);

  useEffect(() => {
    if (reduceMotion || style.waveEvery === null) return;
    const emit = () => setWaves((w) => [...w.slice(-3), ++counter.current]);
    emit();
    const timer = setInterval(emit, style.waveEvery * 1000);
    return () => clearInterval(timer);
  }, [reduceMotion, style.waveEvery]);

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    if (reduceMotion || event.timeStamp - lastRipple.current < 180) return;
    lastRipple.current = event.timeStamp;
    const rect = event.currentTarget.getBoundingClientRect();
    const ripple = {
      id: ++counter.current,
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
    setRipples((r) => [...r.slice(-4), ripple]);
  }

  const core = size * 0.46;

  return (
    <div
      role="img"
      aria-label={t.orb[state]}
      aria-live="polite"
      onPointerMove={onPointerMove}
      className={cn("relative grid shrink-0 place-items-center", className)}
      style={{ width: size, height: size, ["--orb" as string]: style.color }}
    >
      {/* Ambient glow */}
      <motion.div
        aria-hidden
        className="absolute rounded-full blur-2xl"
        style={{ width: core * 1.5, height: core * 1.5, background: "var(--orb)", opacity: 0.22 }}
        animate={
          reduceMotion
            ? undefined
            : { scale: [1, 1 + style.amplitude * 3, 1], opacity: [0.16, 0.3, 0.16] }
        }
        transition={{ duration: style.breath, repeat: Infinity, ease: "easeInOut" }}
      />

      {/* Emitted waves */}
      <AnimatePresence>
        {waves.map((id) => (
          <motion.span
            key={id}
            aria-hidden
            className="absolute rounded-full border"
            style={{ width: core, height: core, borderColor: "var(--orb)" }}
            initial={{ scale: 1, opacity: 0.45 }}
            animate={{ scale: 2.1, opacity: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 3.2, ease: [0.22, 1, 0.36, 1] }}
            onAnimationComplete={() => setWaves((w) => w.filter((x) => x !== id))}
          />
        ))}
      </AnimatePresence>

      {/* State ring: shape carries meaning, not only color */}
      {style.ring !== "none" && (
        <motion.span
          aria-hidden
          className={cn(
            "absolute rounded-full border-2",
            style.ring === "dashed" && "border-dashed",
            style.ring === "orbit" && "border-transparent",
          )}
          style={{
            width: core * 1.42,
            height: core * 1.42,
            borderColor: style.ring === "orbit" ? undefined : "var(--orb)",
            borderTopColor: "var(--orb)",
            opacity: style.ring === "steady" ? 0.55 : 0.8,
          }}
          animate={reduceMotion || style.ring !== "orbit" ? undefined : { rotate: 360 }}
          transition={{ duration: 1.6, repeat: Infinity, ease: "linear" }}
        />
      )}

      {/* Organic core */}
      <motion.div
        aria-hidden
        className="relative overflow-hidden"
        style={{
          width: core,
          height: core,
          borderRadius: BLOB_SHAPES[0],
          background:
            "radial-gradient(circle at 32% 28%, color-mix(in oklab, var(--orb) 35%, white) 0%, var(--orb) 38%, color-mix(in oklab, var(--orb) 55%, black) 100%)",
          boxShadow: "0 0 40px -6px var(--orb), inset 0 0 24px rgb(255 255 255 / 0.18)",
        }}
        animate={
          reduceMotion
            ? undefined
            : {
                borderRadius: BLOB_SHAPES,
                scale: [1, 1 + style.amplitude, 1 - style.amplitude / 2, 1],
              }
        }
        transition={{
          borderRadius: { duration: style.morph, repeat: Infinity, ease: "easeInOut" },
          scale: { duration: style.breath, repeat: Infinity, ease: "easeInOut" },
        }}
      >
        <motion.div
          className="absolute inset-[-30%] opacity-40 mix-blend-overlay"
          style={{ background: "conic-gradient(from 0deg, transparent, white, transparent 40%)" }}
          animate={reduceMotion ? undefined : { rotate: 360 }}
          transition={{ duration: style.morph, repeat: Infinity, ease: "linear" }}
        />
      </motion.div>

      {/* Pointer ripples */}
      <AnimatePresence>
        {ripples.map((r) => (
          <motion.span
            key={r.id}
            aria-hidden
            className="pointer-events-none absolute rounded-full border"
            style={{
              left: r.x - 12,
              top: r.y - 12,
              width: 24,
              height: 24,
              borderColor: "var(--orb)",
            }}
            initial={{ scale: 0.4, opacity: 0.6 }}
            animate={{ scale: 2.6, opacity: 0 }}
            transition={{ duration: 1.1, ease: "easeOut" }}
            onAnimationComplete={() => setRipples((all) => all.filter((x) => x.id !== r.id))}
          />
        ))}
      </AnimatePresence>
    </div>
  );
}

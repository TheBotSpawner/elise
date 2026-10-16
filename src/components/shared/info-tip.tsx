"use client";

import { Info } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { cn } from "@/lib/utils";

const WIDTH = 300;
const GUTTER = 16;

/**
 * ELISE's one contextual-help pattern: a small ⓘ with a compact card anchored to it — never a
 * modal, never a page overlay. Secondary product copy, available when wanted instead of always
 * on the page. Hover (with a pointer) or click/tap opens it; Esc, a click outside or scrolling
 * closes it. The card sits below (or above) the icon and is kept inside the viewport.
 * Only for explanations: warnings and errors stay visible, and anything the user must act on is
 * a Dialog.
 */
export function InfoTip({
  label,
  title,
  body,
  examples,
  size = "sm",
  className,
}: {
  /** Accessible name, e.g. "Acerca de los Métodos". */
  label: string;
  /** Optional small heading inside the card. */
  title?: string;
  body: string[];
  /** Optional short examples, listed under the text. */
  examples?: string[];
  /** "lg" next to a page title; "sm" next to a section label. */
  size?: "sm" | "lg";
  className?: string;
}) {
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const card = useRef<HTMLDivElement>(null);
  // "pinned" = opened by click/tap/keyboard (stays until dismissed); "hover" closes on leave.
  const [open, setOpen] = useState<"pinned" | "hover" | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const leave = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useLayoutEffect(() => {
    if (!open || !button.current) return;
    const r = button.current.getBoundingClientRect();
    const width = Math.min(WIDTH, window.innerWidth - GUTTER * 2);
    const left = Math.min(
      Math.max(GUTTER, r.left + r.width / 2 - width / 2),
      window.innerWidth - GUTTER - width,
    );
    const height = card.current?.offsetHeight ?? 0;
    // Below the icon, or above it when there is no room below.
    const below = r.bottom + 8;
    const top =
      below + height > window.innerHeight - GUTTER && r.top - 8 - height > GUTTER
        ? r.top - 8 - height
        : below;
    setPos({ top, left, width });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(null);
      button.current?.focus();
    };
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!button.current?.contains(target) && !card.current?.contains(target)) setOpen(null);
    };
    const onScroll = () => setOpen(null);
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open]);

  useEffect(() => () => clearTimeout(leave.current), []);

  const hoverIn = (e: React.PointerEvent) => {
    if (e.pointerType !== "mouse") return;
    clearTimeout(leave.current);
    setOpen((o) => o ?? "hover");
  };
  const hoverOut = (e: React.PointerEvent) => {
    if (e.pointerType !== "mouse") return;
    leave.current = setTimeout(() => setOpen((o) => (o === "hover" ? null : o)), 120);
  };

  return (
    <>
      <button
        ref={button}
        type="button"
        aria-label={label}
        aria-expanded={Boolean(open)}
        aria-controls={open ? id : undefined}
        aria-describedby={open ? id : undefined}
        onClick={() => setOpen((o) => (o === "pinned" ? null : "pinned"))}
        onPointerEnter={hoverIn}
        onPointerLeave={hoverOut}
        className={cn(
          // touch-hit: 44px to tap, whatever the icon's size (ADR-066).
          "touch-hit inline-grid shrink-0 place-items-center rounded-full text-faint transition-colors hover:bg-active hover:text-fg focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none aria-expanded:text-fg",
          size === "lg" ? "size-8" : "size-6",
          className,
        )}
      >
        <Info
          className={size === "lg" ? "size-[18px]" : "size-3.5"}
          strokeWidth={size === "lg" ? 1.75 : 1.9}
          aria-hidden
        />
      </button>
      {open &&
        createPortal(
          <div
            ref={card}
            id={id}
            role="tooltip"
            onPointerEnter={hoverIn}
            onPointerLeave={hoverOut}
            style={
              pos
                ? { top: pos.top, left: pos.left, width: pos.width }
                : { top: 0, left: 0, width: WIDTH, visibility: "hidden" }
            }
            className="fixed z-50 flex flex-col gap-2 rounded-2xl border border-border-strong bg-[var(--overlay-bg)] px-4 py-3 text-left text-[13.5px] leading-relaxed font-normal tracking-normal text-muted normal-case shadow-[0_12px_32px_-12px_rgba(0,0,0,0.35)] backdrop-blur-xl"
          >
            {title && <p className="text-[13.5px] font-medium text-fg">{title}</p>}
            {body.map((p) => (
              <p key={p}>{p}</p>
            ))}
            {examples?.length ? (
              <ul className="flex flex-col gap-0.5 text-[13px] text-faint">
                {examples.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
            ) : null}
          </div>,
          document.body,
        )}
    </>
  );
}

/** A section heading ("MÉTODOS") with its ⓘ beside it. */
export function LabelWithInfo({
  id,
  title,
  info,
  as: Tag = "h2",
}: {
  id?: string;
  title: React.ReactNode;
  info: React.ComponentProps<typeof InfoTip>;
  as?: "h2" | "h3" | "label";
}) {
  return (
    <span className="flex items-center gap-1">
      <Tag id={id} className="type-label text-faint">
        {title}
      </Tag>
      <InfoTip {...info} />
    </span>
  );
}

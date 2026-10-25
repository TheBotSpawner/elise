"use client";

import {
  BarChart3,
  Check,
  ChefHat,
  Clock,
  CookingPot,
  Lightbulb,
  ListOrdered,
  Package,
  ShoppingCart,
  Users,
  Wrench,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import type { SurfacePayloads } from "@/core/workspace/registry";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

import { ICONS, SummaryHeader, TONE, CYCLE } from "./summary-card";

type Summary = SurfacePayloads["summary"];
type Recipe = NonNullable<Summary["recipe"]>;
type Guide = NonNullable<Summary["guide"]>;

/** Indexes ticked off while cooking or assembling — this card only, never saved. */
function useTicks() {
  const [ticked, setTicked] = useState<ReadonlySet<number>>(new Set());
  const toggle = (i: number) =>
    setTicked((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  return [ticked, toggle] as const;
}

function Panel({
  icon: Icon,
  title,
  aside,
  children,
  className,
}: {
  icon: typeof Clock;
  title: string;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn("flex min-w-0 flex-col gap-3 rounded-2xl border border-border p-4", className)}
    >
      <h3 className="flex items-center gap-2.5">
        <span
          aria-hidden
          className="grid size-8 place-items-center rounded-lg bg-accent-soft text-accent-text"
        >
          <Icon className="size-4" />
        </span>
        <span className="text-[12px] font-semibold tracking-[0.1em] text-muted uppercase">
          {title}
        </span>
        {aside && <span className="ml-auto">{aside}</span>}
      </h3>
      {children}
    </section>
  );
}

/** A box to tick: checked, it turns green with a check. */
function Tick({
  checked,
  onToggle,
  label,
  round = false,
}: {
  checked: boolean;
  onToggle: () => void;
  label: string;
  round?: boolean;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      onClick={onToggle}
      className={cn(
        "grid size-6 shrink-0 place-items-center border transition-colors",
        round ? "rounded-full" : "rounded-md",
        checked
          ? "border-transparent bg-[#16a36a] text-white"
          : "border-border-strong bg-surface hover:border-accent",
      )}
    >
      {checked && <Check className="size-3.5" strokeWidth={3} aria-hidden />}
    </button>
  );
}

function TipBox({ label, text }: { label: string; text: string }) {
  return (
    <p className="flex items-center gap-3 rounded-2xl border border-accent-line/40 bg-accent-soft/40 px-4 py-3 text-[13.5px] text-fg2">
      <span
        aria-hidden
        className="grid size-8 shrink-0 place-items-center rounded-full bg-surface text-accent-text"
      >
        <Lightbulb className="size-4" />
      </span>
      <span>
        <strong className="font-semibold text-accent-text">{label}</strong> {text}
      </span>
    </p>
  );
}

/**
 * A recipe, laid out as one (ADR-013): its times and servings at a glance, the photo (only one
 * ELISE already showed), ingredients to tick off and numbered steps, then a tip.
 */
export function RecipeCard({ p, title }: { p: Summary & { recipe: Recipe }; title: string }) {
  const { t } = useI18n();
  const r = p.recipe;
  const x = t.workspace.recipe;
  const [ticked, toggle] = useTicks();
  const times = [
    r.prep && { icon: ChefHat, label: x.prep, value: r.prep },
    r.cook && { icon: CookingPot, label: x.cook, value: r.cook },
    r.total && { icon: Clock, label: x.total, value: r.total },
  ].filter((v): v is { icon: typeof Clock; label: string; value: string } => Boolean(v));
  const chips = [
    ...(r.total ? [{ label: r.total, icon: Clock }] : []),
    ...(r.servings ? [{ label: r.servings, icon: Users }] : []),
    ...(r.difficulty ? [{ label: r.difficulty, icon: BarChart3 }] : []),
    ...(p.tags ?? []).map((tag) => ({ label: tag.label, icon: tag.icon && ICONS[tag.icon] })),
  ];
  return (
    <div className="@container flex flex-col gap-4">
      <SummaryHeader title={title} p={{ lead: p.lead, badge: p.badge, tags: [] }} />
      {chips.length > 0 && <ChipRow chips={chips} />}
      <div
        className={cn("grid gap-4", r.image && "@2xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]")}
      >
        {r.image && (
          <figure className="flex min-w-0 flex-col gap-1">
            {/* eslint-disable-next-line @next/next/no-img-element -- a gallery photo ELISE already showed; never proxied. */}
            <img
              src={r.image.url}
              alt={r.image.alt}
              loading="lazy"
              referrerPolicy="no-referrer"
              className="aspect-[4/3] w-full rounded-2xl bg-[image:var(--media-tone)] object-cover"
            />
            {r.image.credit && (
              <figcaption className="text-[11.5px] text-faint">
                {x.photoBy(r.image.credit)}
              </figcaption>
            )}
          </figure>
        )}
        <div className="flex min-w-0 flex-col gap-4">
          {times.length > 0 && (
            <dl className="grid grid-cols-[repeat(auto-fit,minmax(120px,1fr))] gap-3 rounded-2xl border border-border p-3.5">
              {times.map((time) => (
                <div key={time.label} className="flex items-center gap-3">
                  <span
                    aria-hidden
                    className={cn(
                      "grid size-10 shrink-0 place-items-center rounded-full",
                      TONE.teal.bubble,
                    )}
                  >
                    <time.icon className="size-[18px]" />
                  </span>
                  <div className="min-w-0">
                    <dt className="text-[12px] text-muted">{time.label}</dt>
                    <dd className="text-[15px] font-semibold text-fg">{time.value}</dd>
                  </div>
                </div>
              ))}
            </dl>
          )}
          <Panel icon={ShoppingCart} title={x.ingredients}>
            <ul className="grid gap-x-6 gap-y-2.5 @md:grid-cols-2">
              {r.ingredients.map((ingredient, i) => (
                <li key={i} className="flex items-center gap-3 text-[14px] text-fg">
                  <Tick
                    checked={ticked.has(i)}
                    onToggle={() => toggle(i)}
                    label={ingredient}
                    round
                  />
                  <span className={cn(ticked.has(i) && "text-muted line-through")}>
                    {ingredient}
                  </span>
                </li>
              ))}
            </ul>
          </Panel>
        </div>
      </div>
      <Panel icon={ListOrdered} title={x.steps}>
        <ol className="grid gap-x-6 gap-y-3 @2xl:grid-cols-2">
          {r.steps.map((step, i) => (
            <li key={i} className="flex items-start gap-3 text-[14px] leading-relaxed text-fg">
              <span
                aria-hidden
                className={cn(
                  "grid size-8 shrink-0 place-items-center rounded-full text-[13px] font-semibold tabular-nums",
                  TONE.teal.number,
                )}
              >
                {i + 1}
              </span>
              <span className="pt-1">{step}</span>
            </li>
          ))}
        </ol>
        {r.tip && <TipBox label={x.tip} text={r.tip} />}
      </Panel>
    </div>
  );
}

/**
 * Step-by-step instructions (assembling, setting up, a how-to): duration, difficulty and how many
 * materials; materials to tick; steps to mark done with the progress so far, the next one
 * highlighted; and a tip.
 */
export function GuideCard({ p, title }: { p: Summary & { guide: Guide }; title: string }) {
  const { t } = useI18n();
  const g = p.guide;
  const x = t.workspace.guide;
  const [materials, toggleMaterial] = useTicks();
  const [done, toggleDone] = useTicks();
  const materialList = g.materials ?? [];
  const next = g.steps.findIndex((_, i) => !done.has(i));
  const chips = [
    ...(g.duration ? [{ label: g.duration, icon: Clock }] : []),
    ...(g.difficulty ? [{ label: g.difficulty, icon: BarChart3 }] : []),
    ...(materialList.length
      ? [{ label: x.materialsCount(materialList.length), icon: Package }]
      : []),
    ...(p.tags ?? []).map((tag) => ({ label: tag.label, icon: tag.icon && ICONS[tag.icon] })),
  ];
  return (
    <div className="@container flex flex-col gap-4">
      <SummaryHeader
        title={title}
        p={{ lead: p.lead, badge: p.badge ?? x.stepsCount(g.steps.length), tags: [] }}
        icon={g.icon ? ICONS[g.icon] : Wrench}
      />
      {chips.length > 0 && <ChipRow chips={chips} />}
      <div
        className={cn(
          "grid gap-4",
          materialList.length > 0 && "@2xl:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]",
        )}
      >
        {materialList.length > 0 && (
          <Panel
            icon={Package}
            title={x.materials}
            aside={<span className="text-[12.5px] text-muted">{x.items(materialList.length)}</span>}
            className="self-start"
          >
            <ul className="flex flex-col divide-y divide-border rounded-xl border border-border">
              {materialList.map((m, i) => (
                <li key={i} className="flex items-center gap-3 px-3 py-2.5 text-[14px] text-fg">
                  <Tick checked={materials.has(i)} onToggle={() => toggleMaterial(i)} label={m} />
                  <span className={cn(materials.has(i) && "text-muted line-through")}>{m}</span>
                </li>
              ))}
            </ul>
          </Panel>
        )}
        <Panel
          icon={ListOrdered}
          title={x.steps}
          aside={
            <span className="flex flex-col items-end gap-1 text-[12px] text-muted">
              {x.progress(done.size, g.steps.length)}
              <span
                aria-hidden
                className="block h-1.5 w-28 overflow-hidden rounded-full bg-surface-2"
              >
                <span
                  className="block h-full rounded-full bg-accent transition-[width]"
                  style={{ width: `${(done.size / g.steps.length) * 100}%` }}
                />
              </span>
            </span>
          }
        >
          <ol className="flex flex-col gap-2">
            {g.steps.map((step, i) => {
              const isDone = done.has(i);
              const isNext = i === next;
              return (
                <li
                  key={i}
                  className={cn(
                    "flex items-center gap-3 rounded-xl border px-3 py-2.5 transition-colors",
                    isDone
                      ? "border-[color-mix(in_oklab,#16a36a_25%,transparent)] bg-[color-mix(in_oklab,#16a36a_7%,transparent)]"
                      : isNext
                        ? "border-accent-line bg-accent-soft/40"
                        : "border-border",
                  )}
                >
                  <Tick
                    checked={isDone}
                    onToggle={() => toggleDone(i)}
                    label={x.markDone(step.title)}
                    round
                  />
                  <span
                    aria-hidden
                    className={cn(
                      "grid size-8 shrink-0 place-items-center rounded-full border text-[13px] font-semibold tabular-nums",
                      isNext ? "border-accent text-accent-text" : "border-border text-muted",
                    )}
                  >
                    {i + 1}
                  </span>
                  <span className="flex min-w-0 flex-col">
                    <span
                      className={cn(
                        "text-[14.5px] leading-snug font-semibold text-fg",
                        isDone && "text-muted",
                      )}
                    >
                      {step.title}
                    </span>
                    {step.text && (
                      <span className="text-[13px] leading-snug text-muted">{step.text}</span>
                    )}
                  </span>
                </li>
              );
            })}
          </ol>
        </Panel>
      </div>
      {g.tip && <TipBox label={x.tip} text={g.tip} />}
    </div>
  );
}

function ChipRow({ chips }: { chips: { label: string; icon?: typeof Clock }[] }) {
  return (
    <ul className="-mt-1 flex flex-wrap gap-2">
      {chips.map((chip, i) => {
        const tone = TONE[CYCLE[i % CYCLE.length]!];
        return (
          <li
            key={i}
            className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1.5 text-[13px] text-fg"
          >
            {chip.icon && (
              <span className={cn("grid size-5 place-items-center rounded-full", tone.bubble)}>
                <chip.icon className="size-3" aria-hidden />
              </span>
            )}
            {chip.label}
          </li>
        );
      })}
    </ul>
  );
}

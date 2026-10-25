"use client";

import {
  AudioLines,
  BarChart3,
  Check,
  ChevronRight,
  ClipboardList,
  ChefHat,
  Clock,
  CookingPot,
  ExternalLink,
  FileText,
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

import { CYCLE, ICONS, LEADING_NUMBER, SummaryHeader, TONE } from "./summary-card";

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
  heading = "label",
}: {
  icon: typeof Clock;
  title: string;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
  /** "label": a small caps label (recipe); "title": a bold panel title (guide). */
  heading?: "label" | "title";
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
        <span
          className={
            heading === "title"
              ? "text-[17px] font-semibold tracking-tight text-fg"
              : "text-[12px] font-semibold tracking-[0.1em] text-muted uppercase"
          }
        >
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
              <span className="pt-1">{step.replace(LEADING_NUMBER, "")}</span>
            </li>
          ))}
        </ol>
        {r.tip && <TipBox label={x.tip} text={r.tip} />}
      </Panel>
      {r.source && <SourceLink source={r.source} />}
    </div>
  );
}

/**
 * Step-by-step instructions (assembling, setting up, a how-to), laid out like a work sheet: the
 * task's icon, how long and how hard, materials with their icons to tick, steps to mark done with
 * the progress so far (the next one highlighted, its detail one tap away), a tip, and — when the
 * page offers them — "Ver detalle" (the card large) and "Guiame paso a paso" (ELISE walks the
 * person through it, one step at a time).
 */
export function GuideCard({
  p,
  title,
  onDetail,
  onGuide,
}: {
  p: Summary & { guide: Guide };
  title: string;
  onDetail?: () => void;
  onGuide?: () => void;
}) {
  const { t } = useI18n();
  const g = p.guide;
  const x = t.workspace.guide;
  const [materials, toggleMaterial] = useTicks();
  const [done, toggleDone] = useTicks();
  const [open, toggleOpen] = useTicks();
  const materialList = (g.materials ?? []).map((m) =>
    typeof m === "string" ? { label: m, icon: undefined } : m,
  );
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
            icon={ClipboardList}
            title={x.materials}
            heading="title"
            aside={<span className="text-[13px] text-muted">{x.items(materialList.length)}</span>}
            className="self-start"
          >
            <ul className="flex flex-col divide-y divide-border rounded-xl border border-border bg-surface">
              {materialList.map((m, i) => {
                const Icon = m.icon ? ICONS[m.icon] : Package;
                const tone = TONE[CYCLE[i % CYCLE.length]!];
                return (
                  <li key={i} className="flex items-center gap-3 px-3 py-2.5 text-[14px] text-fg">
                    <Tick
                      checked={materials.has(i)}
                      onToggle={() => toggleMaterial(i)}
                      label={m.label}
                    />
                    <span
                      aria-hidden
                      className={cn(
                        "grid size-9 shrink-0 place-items-center rounded-xl",
                        tone.bubble,
                      )}
                    >
                      <Icon className="size-[18px]" />
                    </span>
                    <span className={cn("min-w-0", materials.has(i) && "text-muted line-through")}>
                      {m.label}
                    </span>
                  </li>
                );
              })}
            </ul>
          </Panel>
        )}
        <Panel
          icon={ListOrdered}
          title={x.steps}
          heading="title"
          aside={
            <span className="flex flex-col items-end gap-1.5 text-[12.5px] text-muted">
              {x.progress(done.size, g.steps.length)}
              <span
                aria-hidden
                className="block h-1.5 w-32 overflow-hidden rounded-full bg-surface-2"
              >
                <span
                  className="block h-full rounded-full bg-accent transition-[width] motion-reduce:transition-none"
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
              const expanded = open.has(i);
              return (
                <li
                  key={i}
                  className={cn(
                    "flex items-center gap-3 rounded-xl border px-3 py-2.5 transition-colors",
                    isDone
                      ? "border-[color-mix(in_oklab,#16a36a_25%,transparent)] bg-[color-mix(in_oklab,#16a36a_7%,transparent)]"
                      : isNext
                        ? "border-accent-line bg-accent-soft/40 shadow-[0_0_0_3px_color-mix(in_oklab,var(--color-accent,#0e9fb0)_8%,transparent)]"
                        : "border-border bg-surface",
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
                      "grid size-8 shrink-0 place-items-center rounded-full text-[13px] font-semibold tabular-nums",
                      isNext
                        ? "border-2 border-accent bg-surface text-accent-text"
                        : "bg-surface-2 text-muted",
                    )}
                  >
                    {i + 1}
                  </span>
                  <button
                    type="button"
                    aria-expanded={step.text ? expanded : undefined}
                    disabled={!step.text}
                    onClick={() => toggleOpen(i)}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  >
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span
                        className={cn(
                          "text-[14.5px] leading-snug font-semibold text-fg",
                          isDone && "text-muted",
                        )}
                      >
                        {step.title.replace(LEADING_NUMBER, "")}
                      </span>
                      {step.text && (
                        <span
                          className={cn(
                            "text-[13px] leading-snug text-muted",
                            !expanded && "line-clamp-1",
                          )}
                        >
                          {step.text}
                        </span>
                      )}
                    </span>
                    {step.text && (
                      <ChevronRight
                        aria-hidden
                        className={cn(
                          "size-4 shrink-0 text-faint transition-transform motion-reduce:transition-none",
                          expanded && "rotate-90",
                        )}
                      />
                    )}
                  </button>
                </li>
              );
            })}
          </ol>
        </Panel>
      </div>
      {(g.tip || onDetail || onGuide) && (
        <div className="grid items-stretch gap-3 @2xl:grid-cols-[minmax(0,1fr)_auto_auto]">
          {g.tip ? <TipBox label={x.tip} text={g.tip} /> : <span />}
          {onDetail && (
            <button
              type="button"
              onClick={onDetail}
              className="inline-flex items-center justify-center gap-2 rounded-2xl border border-border bg-surface px-5 py-3 text-[14px] font-medium text-fg hover:bg-active"
            >
              <FileText className="size-4" aria-hidden />
              {x.detail}
            </button>
          )}
          {onGuide && (
            <button
              type="button"
              onClick={onGuide}
              className="inline-flex items-center justify-center gap-2 rounded-2xl bg-accent px-5 py-3 text-[14px] font-medium text-white hover:brightness-95"
            >
              <AudioLines className="size-4" aria-hidden />
              {x.guideMe}
            </button>
          )}
        </div>
      )}
      {g.source && <SourceLink source={g.source} />}
    </div>
  );
}

function SourceLink({ source }: { source: { label: string; url: string } }) {
  const { t } = useI18n();
  return (
    <a
      href={source.url}
      target="_blank"
      rel="noopener noreferrer nofollow"
      className="inline-flex items-center gap-1.5 self-start text-[12.5px] text-accent-text hover:underline"
    >
      <ExternalLink className="size-3" aria-hidden />
      {t.workspace.guide.source(source.label)}
    </a>
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

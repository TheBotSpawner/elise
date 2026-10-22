"use client";

import { Bell, Check, CircleAlert } from "lucide-react";

import type { SurfacePayloads } from "@/core/workspace/registry";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

type Shopping = SurfacePayloads["shopping"];

/** Cents → "$ 1.234,50" in the reader's locale (ARS). */
function useMoney() {
  const { locale } = useI18n();
  const money = (cents: number) =>
    new Intl.NumberFormat(locale, {
      style: "currency",
      currency: "ARS",
      maximumFractionDigits: cents % 100 ? 2 : 0,
    }).format(cents / 100);
  const day = (d: string) =>
    new Intl.DateTimeFormat(locale, {
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    }).format(new Date(`${d}T12:00:00Z`));
  return { money, day };
}

/**
 * Supermarket prices (ADR-111) as a Surface: every amount computed by ELISE from SEPA, with the
 * province, the day and how it was aggregated always in view — never a store's exact price.
 */
export function ShoppingBody({ p, large }: { p: Shopping; large?: boolean }) {
  const { t } = useI18n();
  const x = t.shopping;
  const { day } = useMoney();
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[12.5px] text-muted">
        {x.reference(p.regionName)}
        {p.date ? ` · ${x.dataOf(day(p.date))}` : ""}
      </p>
      {p.mode === "product" && <ProductPrices p={p} />}
      {p.mode === "basket" && p.basket && <Basket p={p} open={large} />}
      {p.mode === "history" && p.history && <History p={p} />}
      {p.candidates.length > 0 && <Candidates p={p} />}
      {p.mode === "alerts" && <Alerts p={p} />}
      {p.notes.map((n) => (
        <p key={n} className="flex gap-1.5 text-[12.5px] text-muted">
          <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-faint" aria-hidden />
          {n}
        </p>
      ))}
      <footer className="flex flex-col gap-0.5 border-t border-border pt-2 text-[11.5px] text-faint">
        <span>{x.basis}</span>
        <a href={p.source.url} target="_blank" rel="noreferrer" className="hover:text-muted">
          {x.source}
        </a>
      </footer>
    </div>
  );
}

function ProductPrices({ p }: { p: Shopping }) {
  const { t } = useI18n();
  const x = t.shopping;
  const { money } = useMoney();
  const cheapest = p.chains[0]?.listCents;
  return (
    <>
      {p.product && (
        <div>
          <p className="text-[15px]">{p.product.name}</p>
          <p className="text-[12.5px] text-faint">
            {[p.product.brand, p.product.size, p.product.ean].filter(Boolean).join(" · ")}
          </p>
        </div>
      )}
      <ul className="flex flex-col divide-y divide-border">
        {p.chains.map((c) => (
          <li key={c.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-2">
            <span className="min-w-0 flex-1 truncate text-[14px]">{c.name}</span>
            <span
              className={cn(
                "font-mono text-[14.5px]",
                c.listCents === cheapest && p.chains.length > 1 && "text-accent-text",
              )}
            >
              {money(c.listCents)}
            </span>
            <span className="w-full text-[12px] text-faint">
              {[
                c.perUnit ? x.perUnit(money(c.perUnit.cents), c.perUnit.per) : null,
                x.branches(c.branches),
                c.promoCents !== null
                  ? `${x.promo(money(c.promoCents))}${c.promoLabel ? ` (${c.promoLabel})` : ""}`
                  : null,
                c.conditionalLabel ? `${x.conditional}: ${c.conditionalLabel}` : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}

function Basket({ p, open }: { p: Shopping; open?: boolean }) {
  const { t } = useI18n();
  const x = t.shopping;
  const { money } = useMoney();
  const b = p.basket!;
  const name = (id: string) => b.chains.find((c) => c.id === id)?.name ?? id;
  const sorted = [...b.chains].sort((a, c) => a.commonCents - c.commonCents);
  return (
    <>
      <p className="text-[13.5px]">{x.common(b.commonLines, b.requested)}</p>
      {b.cheapestCommon ? (
        <p className="text-[13.5px] text-accent-text">
          {x.cheapest(name(b.cheapestCommon.chainId), money(b.cheapestCommon.savingsCents))}
        </p>
      ) : (
        b.chains.length > 1 && <p className="text-[13px] text-muted">{x.noComparison}</p>
      )}
      <table className="w-full text-[13.5px]">
        <thead>
          <tr className="text-left text-[11.5px] text-faint">
            <th className="py-1 font-normal" />
            <th className="py-1 text-right font-normal">{x.commonSubtotal}</th>
            <th className="py-1 text-right font-normal">{x.available}</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((c) => (
            <tr key={c.id} className="border-t border-border">
              <td className="py-1.5 pr-2">
                <span className="block truncate">{c.name}</span>
                {c.full && (
                  <span className="flex items-center gap-1 text-[11.5px] text-success">
                    <Check className="size-3" aria-hidden />
                    {x.full}
                  </span>
                )}
              </td>
              <td className="py-1.5 text-right font-mono">
                {b.commonLines ? money(c.commonCents) : "—"}
              </td>
              <td className="py-1.5 text-right font-mono text-muted">
                {money(c.availableCents)}
                <span className="block text-[11px] text-faint">
                  {x.covered(c.covered, b.requested)}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <details open={open} className="text-[13px]">
        <summary className="cursor-pointer text-muted">{x.lines}</summary>
        <ul className="mt-2 flex flex-col gap-1.5">
          {b.lines.map((l, i) => (
            <li key={`${l.label}-${i}`} className="flex flex-col">
              <span>
                {l.product?.name ?? l.label}{" "}
                <span className="text-faint">{x.quantity(l.quantity)}</span>
              </span>
              <span className="text-[12px] text-faint">
                {l.status === "unresolved"
                  ? x.unresolved
                  : l.status === "no_price"
                    ? x.noPrice
                    : l.prices
                        .map(
                          (q) =>
                            `${name(q.chainId)} ${money(q.lineCents)}${q.chainId === l.cheapestChainId && l.prices.length > 1 ? " ✓" : ""}`,
                        )
                        .join(" · ")}
              </span>
            </li>
          ))}
        </ul>
      </details>
    </>
  );
}

/** A step chart: real observations as dots, carried days as the line between them. */
function History({ p }: { p: Shopping }) {
  const { t } = useI18n();
  const x = t.shopping;
  const { money, day } = useMoney();
  const h = p.history!;
  const all = h.series.flatMap((s) => s.points.flatMap((q) => (q.cents !== null ? [q.cents] : [])));
  const min = Math.min(...all);
  const max = Math.max(...all);
  const W = 300;
  const H = 80;
  const y = (c: number) => (max === min ? H / 2 : H - 4 - ((c - min) / (max - min)) * (H - 8));
  return (
    <>
      <p className="text-[13.5px]">{x.history}</p>
      {all.length > 0 && (
        <svg viewBox={`0 0 ${W} ${H}`} className="h-24 w-full" role="img" aria-label={x.history}>
          {h.series.map((s, si) => {
            const n = s.points.length;
            const xs = (i: number) => (n > 1 ? (i / (n - 1)) * W : W / 2);
            let d = "";
            s.points.forEach((q, i) => {
              if (q.cents === null) return;
              d += d
                ? `H${xs(i).toFixed(1)}V${y(q.cents).toFixed(1)}`
                : `M${xs(i).toFixed(1)},${y(q.cents).toFixed(1)}`;
            });
            return (
              <g key={s.chain} className={si ? "opacity-60" : ""}>
                <path
                  d={d}
                  fill="none"
                  strokeWidth={1.5}
                  className="stroke-accent"
                  vectorEffect="non-scaling-stroke"
                />
                {s.points.map((q, i) =>
                  q.observed && q.cents !== null ? (
                    <circle key={i} cx={xs(i)} cy={y(q.cents)} r={2} className="fill-accent">
                      <title>{`${s.chain} · ${day(q.date)} · ${money(q.cents)}`}</title>
                    </circle>
                  ) : null,
                )}
              </g>
            );
          })}
        </svg>
      )}
      <p className="text-[11.5px] text-faint">
        ● {x.observed} · — {x.carried}
      </p>
      {h.change && (
        <p className="text-[13.5px]">
          {x.change(
            h.change.chain,
            `${h.change.percent > 0 ? "+" : ""}${h.change.percent.toLocaleString()}%`,
            day(h.change.from.date),
            day(h.change.to.date),
          )}
        </p>
      )}
    </>
  );
}

function Candidates({ p }: { p: Shopping }) {
  const { t } = useI18n();
  const x = t.shopping;
  const { money } = useMoney();
  return (
    <div className="flex flex-col gap-2">
      <p className="text-[13.5px]">{x.candidates}</p>
      <ol className="flex flex-col gap-1.5">
        {p.candidates.map((c, i) => (
          <li
            key={`${c.ean}-${c.forLine ?? ""}`}
            className="rounded-xl border border-border px-3 py-2"
          >
            {c.forLine && <span className="block text-[11.5px] text-faint">{c.forLine}</span>}
            <span className="block text-[14px]">
              {i + 1}. {c.name}
            </span>
            <span className="block text-[12px] text-faint">
              {[
                c.brand,
                c.size,
                c.fromCents !== null ? x.from(money(c.fromCents)) : null,
                ...c.extraVariant.map((v) => x.variant(v)),
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
          </li>
        ))}
      </ol>
      <p className="text-[12.5px] text-muted">{x.candidatesHint}</p>
    </div>
  );
}

function Alerts({ p }: { p: Shopping }) {
  const { t } = useI18n();
  const x = t.shopping;
  const { money, day } = useMoney();
  if (!p.alerts.length) return <p className="text-[13.5px] text-muted">{x.noAlerts}</p>;
  return (
    <ul className="flex flex-col gap-2">
      {p.alerts.map((a) => (
        <li key={`${a.product}-${a.thresholdCents}`} className="flex gap-2.5">
          <Bell className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
          <span className="flex flex-col">
            <span className="text-[14px]">{a.product}</span>
            <span className="text-[12.5px] text-muted">
              {x.alertLine(money(a.thresholdCents), a.region)}
            </span>
            {a.lastBestCents !== null && a.lastBestChain && a.lastQuoteDate && (
              <span className="text-[12px] text-faint">
                {x.lastSeen(money(a.lastBestCents), a.lastBestChain, day(a.lastQuoteDate))}
              </span>
            )}
            {a.state === "triggered" && (
              <span className="text-[12px] text-accent-text">{x.triggered}</span>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

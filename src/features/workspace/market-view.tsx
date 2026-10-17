"use client";

import type { SurfacePayloads } from "@/core/workspace/registry";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

type Market = SurfacePayloads["market"];
type Quote = Market["quotes"][number];

function useMarketFormat(timezone: string) {
  const { locale } = useI18n();
  const money = (n: number, currency: string | null) =>
    currency
      ? new Intl.NumberFormat(locale, {
          style: "currency",
          currency,
          maximumFractionDigits: 2,
        }).format(n)
      : new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(n);
  const num = (n: number) => new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(n);
  const compact = (n: number) =>
    new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }).format(n);
  const pct = (n: number) => `${n > 0 ? "+" : ""}${num(n)}%`;
  const time = (iso: string) =>
    new Intl.DateTimeFormat(locale, {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: timezone,
    }).format(new Date(iso));
  const day = (iso: string) =>
    new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", timeZone: "UTC" }).format(
      new Date(`${iso}T12:00:00Z`),
    );
  return { money, num, compact, pct, time, day };
}

/** Up, down or flat as words and sign — never color alone. */
function Change({
  change,
  percent,
  currency,
}: {
  change: number | null;
  percent: number | null;
  currency: string | null;
}) {
  const f = useMarketFormat("UTC");
  if (percent === null && change === null) return null;
  const up = (percent ?? change ?? 0) > 0;
  const down = (percent ?? change ?? 0) < 0;
  return (
    <span
      className={cn("font-mono tabular-nums", up && "text-success", down && "text-danger-text")}
    >
      {change !== null && `${change > 0 ? "+" : ""}${f.money(change, currency)} `}
      {percent !== null && `(${f.pct(percent)})`}
    </span>
  );
}

function QuoteCard({ q, timezone }: { q: Quote; timezone: string }) {
  const { t } = useI18n();
  const m = t.workspace.market;
  const f = useMarketFormat(timezone);
  const facts = [
    [m.open, q.open],
    [m.high, q.dayHigh],
    [m.low, q.dayLow],
    [m.previousClose, q.previousClose],
  ].filter((x): x is [string, number] => x[1] !== null);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-mono text-[28px] leading-none tabular-nums">
          {f.money(q.price, q.currency)}
        </span>
        <Change change={q.change} percent={q.changePercent} currency={q.currency} />
      </div>
      {facts.length > 0 && (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-[12.5px] sm:grid-cols-4">
          {facts.map(([label, value]) => (
            <div key={label} className="flex flex-col">
              <dt className="text-faint">{label}</dt>
              <dd className="font-mono tabular-nums">{f.money(value, q.currency)}</dd>
            </div>
          ))}
        </dl>
      )}
      <p className="text-[11.5px] text-faint">
        {[
          q.volume !== null ? `${m.volume} ${f.compact(q.volume)}` : null,
          q.asOf ? m.asOf(f.time(q.asOf)) : null,
          q.freshness === "live" ? null : m.notLive,
        ]
          .filter(Boolean)
          .join(" · ")}
      </p>
    </div>
  );
}

/** Followed assets: the biggest movers first, one compact row each. */
function WatchList({ quotes, timezone }: { quotes: Quote[]; timezone: string }) {
  const { t } = useI18n();
  const m = t.workspace.market;
  const f = useMarketFormat(timezone);
  const sorted = [...quotes].sort(
    (a, b) => Math.abs(b.changePercent ?? 0) - Math.abs(a.changePercent ?? 0),
  );
  const latest = quotes
    .map((q) => q.asOf)
    .filter(Boolean)
    .sort()
    .at(-1);
  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-col divide-y divide-border">
        {sorted.map((q) => (
          <li
            key={q.symbol}
            className="flex items-baseline justify-between gap-3 py-1.5 text-[13.5px]"
          >
            <span className="min-w-0 truncate">
              <span className="font-mono font-medium">{q.symbol}</span>
              {q.name && <span className="text-muted"> · {q.name}</span>}
            </span>
            <span className="flex shrink-0 items-baseline gap-3">
              <span className="font-mono tabular-nums">{f.money(q.price, q.currency)}</span>
              <Change change={null} percent={q.changePercent} currency={q.currency} />
            </span>
          </li>
        ))}
      </ul>
      {latest && <p className="text-[11.5px] text-faint">{m.asOf(f.time(latest))}</p>}
    </div>
  );
}

/** A period's closes as a thin line (no axes): the shape, with its computed change. */
function History({ h, timezone }: { h: NonNullable<Market["history"]>; timezone: string }) {
  const { t } = useI18n();
  const m = t.workspace.market;
  const f = useMarketFormat(timezone);
  const closes = h.points.map((p) => p.close);
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const W = 300;
  const H = 64;
  const path = closes
    .map((c, i) => {
      const x = closes.length > 1 ? (i / (closes.length - 1)) * W : W / 2;
      const y = max === min ? H / 2 : H - ((c - min) / (max - min)) * H;
      return `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const c = h.change;
  return (
    <div className="flex flex-col gap-3">
      {c && (
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="font-mono text-[24px] leading-none tabular-nums">
            {f.money(c.end, h.currency)}
          </span>
          <Change change={c.change} percent={c.changePercent} currency={h.currency} />
          <span className="text-[12px] text-faint">{m.period(f.day(c.from), f.day(c.to))}</span>
        </div>
      )}
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-16 w-full"
        preserveAspectRatio="none"
        role="img"
        aria-label={m.chart(h.symbol)}
      >
        <path
          d={path}
          fill="none"
          strokeWidth={1.75}
          className="stroke-accent"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      {c && (
        <p className="text-[12px] text-muted">
          {m.range(f.money(c.low, h.currency), f.money(c.high, h.currency))}
        </p>
      )}
    </div>
  );
}

/** Public market data (ADR-074): the quote is the answer; nothing here suggests a trade. */
export function MarketBody({ p, timezone }: { p: Market; timezone: string }) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-3">
      {p.mode === "history" && p.history ? (
        <History h={p.history} timezone={timezone} />
      ) : p.quotes.length === 1 ? (
        <QuoteCard q={p.quotes[0]!} timezone={timezone} />
      ) : (
        <WatchList quotes={p.quotes} timezone={timezone} />
      )}
      {p.unavailable.length > 0 && (
        <p className="text-[12px] text-approval-text">
          {t.workspace.market.unavailable(p.unavailable.join(", "))}
        </p>
      )}
    </div>
  );
}

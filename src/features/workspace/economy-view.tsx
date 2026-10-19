"use client";

import type { SurfacePayloads } from "@/core/workspace/registry";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

type Economy = SurfacePayloads["economy"];
type Unit = Economy["unit"];

function useFormat(timezone: string) {
  const { locale } = useI18n();
  const num = (n: number, digits = 2) =>
    new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(n);
  const value = (n: number, unit: Unit) =>
    unit === "ars" || unit === "usd"
      ? new Intl.NumberFormat(locale, {
          style: "currency",
          currency: unit === "ars" ? "ARS" : "USD",
          maximumFractionDigits: 2,
        }).format(n)
      : unit === "percent"
        ? `${num(n)}%`
        : unit === "points"
          ? `${num(n, 0)}`
          : num(n, 4);
  /** A day ("2026-10-12"), a month ("2026-09") or an instant (ISO): never shifted by UTC. */
  const when = (s: string) => {
    if (/^\d{4}-\d{2}$/.test(s))
      return new Intl.DateTimeFormat(locale, {
        month: "long",
        year: "numeric",
        timeZone: "UTC",
      }).format(new Date(`${s}-15T12:00:00Z`));
    if (/^\d{4}-\d{2}-\d{2}$/.test(s))
      return new Intl.DateTimeFormat(locale, {
        weekday: "short",
        day: "numeric",
        month: "short",
        timeZone: "UTC",
      }).format(new Date(`${s}T12:00:00Z`));
    return new Intl.DateTimeFormat(locale, {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: timezone,
    }).format(new Date(s));
  };
  return { num, value, when };
}

/** The shape of a series as a thin line (no axes): the numbers are in the rows and headline. */
function Spark({ series, label }: { series: NonNullable<Economy["series"]>; label: string }) {
  const values = series.map((p) => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const W = 300;
  const H = 64;
  const d = values
    .map((v, i) => {
      const x = values.length > 1 ? (i / (values.length - 1)) * W : W / 2;
      const y = max === min ? H / 2 : H - ((v - min) / (max - min)) * H;
      return `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="h-16 w-full"
      preserveAspectRatio="none"
      role="img"
      aria-label={label}
    >
      <path
        d={d}
        fill="none"
        strokeWidth={1.75}
        className="stroke-accent"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

/** Public economic data (ADR-094): each figure with its date, and its source to cite. */
export function EconomyBody({ p, timezone }: { p: Economy; timezone: string }) {
  const { t } = useI18n();
  const e = t.workspace.economy;
  const f = useFormat(timezone);
  const h = p.headline;
  const quotes = p.mode === "rates" || p.rows.some((r) => r.buy !== null || r.sell !== null);
  return (
    <div className="flex flex-col gap-3">
      {h && (
        <div className="flex flex-col gap-0.5">
          <span className="text-[12.5px] text-muted">{h.label}</span>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="font-mono text-[26px] leading-none tabular-nums">
              {f.value(h.value, h.unit)}
            </span>
            {h.period && <span className="text-[12px] text-faint">{h.period}</span>}
          </div>
          {h.partial && <span className="text-[12px] text-approval-text">{e.partial}</span>}
        </div>
      )}
      {p.series && p.series.length > 1 && <Spark series={p.series} label={e.chart} />}
      {p.rows.length > 0 && (
        <table className="w-full text-[13.5px]">
          {quotes && (
            <thead>
              <tr className="text-[11.5px] text-faint">
                <th className="py-1 text-left font-normal">{e.market}</th>
                <th className="py-1 text-right font-normal">{e.buy}</th>
                <th className="py-1 text-right font-normal">{e.sell}</th>
              </tr>
            </thead>
          )}
          {p.mode === "deposits" && (
            <thead>
              <tr className="text-[11.5px] text-faint">
                <th className="py-1 text-left font-normal">{e.bank}</th>
                <th className="py-1 text-right font-normal">{e.tnaClients}</th>
                <th className="py-1 text-right font-normal">{e.tnaNonClients}</th>
              </tr>
            </thead>
          )}
          <tbody className="divide-y divide-border">
            {p.rows.map((r, i) => (
              <tr key={`${r.label}:${r.date ?? i}`} className="align-baseline">
                <td className="py-1.5 pr-3">
                  <span className="block">{r.label}</span>
                  {r.date && (
                    <span className="block text-[11.5px] text-faint">{f.when(r.date)}</span>
                  )}
                </td>
                {quotes ? (
                  <>
                    <td className="py-1.5 text-right font-mono tabular-nums">
                      {r.buy !== null ? f.value(r.buy, p.unit) : "—"}
                    </td>
                    <td className="py-1.5 text-right font-mono tabular-nums">
                      {r.sell !== null ? f.value(r.sell, p.unit) : "—"}
                    </td>
                  </>
                ) : p.mode === "deposits" ? (
                  <>
                    <td className="py-1.5 text-right font-mono tabular-nums">
                      {r.buy !== null ? f.value(r.buy, "percent") : "—"}
                    </td>
                    <td className="py-1.5 text-right font-mono tabular-nums">
                      {r.sell !== null ? f.value(r.sell, "percent") : "—"}
                    </td>
                  </>
                ) : p.mode === "holidays" ? (
                  <td className="py-1.5 text-right">
                    <span
                      className={cn(
                        "rounded-full px-2 py-0.5 text-[11.5px]",
                        r.kind === "puente" || r.kind === "bancario"
                          ? "bg-surface-2 text-muted"
                          : "bg-accent-soft text-accent-text",
                      )}
                    >
                      {e.kinds[(r.kind ?? "inamovible") as keyof typeof e.kinds] ?? r.kind}
                    </span>
                  </td>
                ) : (
                  <td className="py-1.5 text-right font-mono tabular-nums">
                    {r.value !== null ? f.value(r.value, p.unit) : "—"}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {p.notes.length > 0 && (
        <ul className="flex flex-col gap-0.5 text-[12px] text-muted">
          {p.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
      <p className="text-[11.5px] text-faint">
        {p.sources.map((s, i) => (
          <span key={s.name}>
            {i > 0 && " · "}
            {e.source}{" "}
            <a
              href={s.url}
              target="_blank"
              rel="noreferrer"
              className="underline-offset-2 hover:underline"
            >
              {s.name}
            </a>
            {s.original ? ` (${s.original})` : ""} · {e.read(f.when(s.fetchedAt))}
            {s.stale && <span className="text-approval-text"> · {e.stale}</span>}
          </span>
        ))}
      </p>
    </div>
  );
}

"use client";

import { PageContainer, PageHeader } from "@/components/shared/page";
import { Card } from "@/components/ui/card";

import type { UsageProps } from "./load";

const usd = (n: number) => `$${n < 1 ? n.toFixed(4) : n.toFixed(2)}`;
const num = (n: number) => n.toLocaleString("en-US");

const maybe = (n: number | null) => (n === null ? "—" : usd(n));

/**
 * Variable cost that can be assigned to accounts. Vercel, Supabase and Trigger.dev plans aren't here:
 * they're shared and fixed. Unpriced calls show their count and stay out of every total's meaning.
 */
function CostSection({ report }: { report: NonNullable<UsageProps["summary"]["report"]> }) {
  const lines: [string, string][] = [
    ["Active accounts", num(report.activeAccounts)],
    ["Per account, p50 / p95", `${maybe(report.perAccount.p50)} / ${maybe(report.perAccount.p95)}`],
    ["Per turn, p50 / p95", `${maybe(report.perTurn.p50)} / ${maybe(report.perTurn.p95)}`],
    [
      "Per voice minute",
      report.voice.minutes ? usd(report.voice.cost / report.voice.minutes) : "—",
    ],
    ["Calls without a verified price", num(report.unpriced)],
  ];
  return (
    <div className="mb-6 grid gap-6 md:grid-cols-3">
      <Card className="p-5">
        <h2 className="mb-3 font-medium">Variable cost</h2>
        <ul className="space-y-1 text-[13px] tabular-nums">
          {lines.map(([label, value]) => (
            <li key={label} className="flex justify-between gap-3">
              <span>{label}</span>
              <span>{value}</span>
            </li>
          ))}
        </ul>
      </Card>
      <Card className="p-5">
        <h2 className="mb-3 font-medium">By provider</h2>
        <ul className="space-y-1 text-[13px] tabular-nums">
          {report.byProvider.slice(0, 10).map((p) => (
            <li
              key={`${p.provider}|${p.operation}|${p.status}`}
              className="flex justify-between gap-3"
            >
              <span className="truncate">
                {p.provider} · {p.operation} · {p.status}
              </span>
              <span>{usd(p.cost)}</span>
            </li>
          ))}
        </ul>
      </Card>
      <Card className="p-5">
        <h2 className="mb-3 font-medium">Top accounts and refusals</h2>
        <ul className="space-y-1 text-[13px] tabular-nums">
          {report.top.map((t) => (
            <li key={t.who} className="flex justify-between gap-3">
              <span className="font-mono">{t.who}</span>
              <span>{usd(t.cost)}</span>
            </li>
          ))}
          {Object.entries(report.wouldDeny).map(([reason, n]) => (
            <li key={reason} className="flex justify-between gap-3 text-muted">
              <span>{reason}</span>
              <span>{num(n)}</span>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

export function View({ summary }: UsageProps) {
  return (
    <PageContainer>
      <PageHeader
        title="Usage"
        subtitle={`Last ${summary.days} days · ${num(summary.totals.calls)} paid calls · ${usd(summary.totals.costUsd)} estimated · ${summary.totals.workspaces} workspaces`}
      />
      <p className="mb-6 text-[13px] text-muted">
        Costs come from src/config/pricing.ts at list prices: not invoices, credits or fixed plans.
        {summary.truncated && " Showing the most recent 20,000 events."}
      </p>

      {summary.report && <CostSection report={summary.report} />}

      <Card className="overflow-x-auto p-0">
        <table className="w-full min-w-[720px] text-left text-[13px]">
          <thead className="text-faint">
            <tr className="border-b border-border">
              {[
                "Feature",
                "Operation",
                "Model",
                "Calls",
                "Failed",
                "In tok",
                "Out tok",
                "Cached",
                "Units",
                "Avg ms",
                "Est. cost",
              ].map((h) => (
                <th key={h} scope="col" className="px-3 py-2 font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {summary.rows.map((r) => (
              <tr key={`${r.feature}|${r.operation}|${r.model}`} className="border-b border-border">
                <td className="px-3 py-2">{r.feature}</td>
                <td className="px-3 py-2">{r.operation}</td>
                <td className="px-3 py-2 font-mono text-[12px]">{r.model}</td>
                <td className="px-3 py-2 tabular-nums">{num(r.calls)}</td>
                <td className="px-3 py-2 tabular-nums">{r.failed ? num(r.failed) : "—"}</td>
                <td className="px-3 py-2 tabular-nums">{num(r.inputTokens)}</td>
                <td className="px-3 py-2 tabular-nums">{num(r.outputTokens)}</td>
                <td className="px-3 py-2 tabular-nums">{num(r.cachedTokens)}</td>
                <td className="px-3 py-2 tabular-nums">
                  {r.units ? `${num(Math.round(r.units))} ${r.unit ?? ""}` : "—"}
                </td>
                <td className="px-3 py-2 tabular-nums">{r.avgLatencyMs ?? "—"}</td>
                <td className="px-3 py-2 tabular-nums">{usd(r.costUsd)}</td>
              </tr>
            ))}
            {!summary.rows.length && (
              <tr>
                <td colSpan={11} className="px-3 py-6 text-center text-muted">
                  No usage recorded yet. Usage rows appear after the productization migration is
                  applied and ELISE handles a request.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>

      <div className="mt-6 grid gap-6 md:grid-cols-2">
        <Card className="p-5">
          <h2 className="mb-3 font-medium">By day</h2>
          <ul className="space-y-1 text-[13px] tabular-nums">
            {summary.byDay.map((d) => (
              <li key={d.day} className="flex justify-between">
                <span>{d.day}</span>
                <span>
                  {num(d.calls)} · {usd(d.costUsd)}
                </span>
              </li>
            ))}
          </ul>
        </Card>
        <Card className="p-5">
          <h2 className="mb-3 font-medium">Background jobs</h2>
          <ul className="space-y-1 text-[13px] tabular-nums">
            {summary.jobs.map((j) => (
              <li key={`${j.kind}:${j.status}`} className="flex justify-between">
                <span>
                  {j.kind} · {j.status}
                </span>
                <span>{num(j.count)}</span>
              </li>
            ))}
            {!summary.jobs.length && <li className="text-muted">No runs in this period.</li>}
          </ul>
        </Card>
      </div>
    </PageContainer>
  );
}

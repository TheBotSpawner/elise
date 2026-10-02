import { notFound } from "next/navigation";

import { requireAuthContext } from "@/application/auth-context";
import { isAdmin, usageSummary } from "@/application/usage-service";
import { PageContainer, PageHeader } from "@/components/shared/page";
import { Card } from "@/components/ui/card";
import { isEnabled } from "@/config/flags";

export const dynamic = "force-dynamic";

const usd = (n: number) => `$${n < 1 ? n.toFixed(4) : n.toFixed(2)}`;
const num = (n: number) => n.toLocaleString("en-US");

/**
 * Internal usage view (ADR-019): AI requests, tokens, estimated cost, web queries, voice and
 * background jobs, aggregated. Only for ELISE_ADMIN_EMAILS; everyone else gets a 404. No
 * content and no user identities — this is engineering visibility, not customer billing.
 */
export default async function UsagePage() {
  const auth = await requireAuthContext();
  if (!isEnabled("usagePage") || !isAdmin(auth)) notFound();
  const summary = await usageSummary(auth, 30);

  return (
    <PageContainer>
      <PageHeader
        title="Usage"
        subtitle={`Last ${summary.days} days · ${num(summary.totals.calls)} paid calls · ${usd(summary.totals.costUsd)} estimated · ${summary.totals.workspaces} workspaces`}
      />
      <p className="mb-6 text-[13px] text-muted">
        Costs are estimates from src/config/pricing.ts, not invoices.
        {summary.truncated && " Showing the most recent 20,000 events."}
      </p>

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

import { notFound } from "next/navigation";

import { requireAuthContext } from "@/application/auth-context";
import { recentTurnPerf } from "@/application/perf-service";
import { isAdmin } from "@/application/usage-service";
import { PageContainer, PageHeader } from "@/components/shared/page";
import { Card } from "@/components/ui/card";
import { isEnabled } from "@/config/flags";

export const dynamic = "force-dynamic";

const ms = (n: number | null | undefined) =>
  n == null ? "–" : n < 1000 ? `${Math.round(n)} ms` : `${(n / 1000).toFixed(1)} s`;
const pair = ([a, b]: [number | null, number | null]) => `${ms(a)} / ${ms(b)}`;

/**
 * Internal performance view (ADR-025): recent turns with their timeline — setup, each model
 * call (profile, reasoning, tokens, cache), each tool — and p50/p90 per intent. Engineering
 * tooling for ELISE_ADMIN_EMAILS only; no content is ever recorded or shown.
 */
export default async function PerfPage() {
  const auth = await requireAuthContext();
  if (!isEnabled("usagePage") || !isAdmin(auth)) notFound();
  const { turns, groups } = await recentTurnPerf(auth);

  return (
    <PageContainer>
      <PageHeader
        title="Performance"
        subtitle={`Last ${turns.length} turns · times from request arrival · p50 / p90`}
      />
      <Card className="mb-6 overflow-x-auto p-0">
        <table className="w-full min-w-[640px] text-left text-[13px]">
          <thead className="text-faint">
            <tr className="border-b border-border">
              {["Intent · modality", "Turns", "First text", "First Surface", "Complete"].map(
                (h) => (
                  <th key={h} scope="col" className="px-3 py-2 font-medium">
                    {h}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <tr key={g.intent} className="border-b border-border">
                <td className="px-3 py-2">{g.intent}</td>
                <td className="px-3 py-2">{g.n}</td>
                <td className="px-3 py-2 font-mono">{pair(g.ttft)}</td>
                <td className="px-3 py-2 font-mono">{pair(g.firstSurface)}</td>
                <td className="px-3 py-2 font-mono">{pair(g.total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <div className="flex flex-col gap-3">
        {turns.map(({ runId, at, status, perf }) => {
          const m = perf.metrics;
          const cached = m.inputTokens ? Math.round((100 * m.cachedTokens) / m.inputTokens) : 0;
          return (
            <Card key={runId} className="p-4 text-[13px]">
              <details>
                <summary className="flex cursor-pointer flex-wrap gap-x-4 gap-y-1">
                  <span className="text-fg">
                    {perf.intent ?? "general"} · {perf.modality}
                    {status !== "completed" ? ` · ${status}` : ""}
                  </span>
                  <span className="text-muted">
                    {perf.models[0]?.model ?? "–"} · {perf.profile ?? "–"} ·{" "}
                    {perf.models[0]?.reasoning ?? "default"}
                  </span>
                  <span className="font-mono text-muted">
                    first text {ms(m.ttft)} · surface {ms(m.firstSurface)} · total {ms(m.total)}
                  </span>
                  <span className="font-mono text-faint">
                    {m.modelCalls} model · {m.toolCalls} tools · {m.inputTokens} in ({cached}%
                    cached) · {m.toolsExposed} tools exposed
                  </span>
                  <span className="text-faint">{new Date(at).toLocaleString()}</span>
                </summary>
                <ul className="mt-3 flex flex-col gap-1 font-mono text-[12px] text-muted">
                  <li>
                    setup:{" "}
                    {Object.entries(perf.spans)
                      .map(([k, v]) => `${k} ${ms(v)}`)
                      .join(" · ")}
                  </li>
                  <li>first byte {ms(m.ttfbServer)}</li>
                  {perf.models.map((c, i) => (
                    <li key={`m${i}`}>
                      model #{i + 1} {c.model} ({c.profile}, {c.reasoning ?? "default"}
                      {c.serviceTier && c.serviceTier !== "default"
                        ? `, ${c.serviceTier}`
                        : ""}) {ms(c.start)} → first {ms(c.firstEvent)} → end {ms(c.end)} ·{" "}
                      {c.inputTokens} in / {c.cachedTokens} cached / {c.outputTokens} out (
                      {c.reasoningTokens} reasoning) · {c.toolCalls} calls
                    </li>
                  ))}
                  {perf.tools.map((t, i) => (
                    <li key={`t${i}`}>
                      tool {t.name} {ms(t.start)} → {ms(t.end)} ({ms(t.end - t.start)})
                      {t.ok ? "" : " failed"}
                    </li>
                  ))}
                </ul>
              </details>
            </Card>
          );
        })}
      </div>
    </PageContainer>
  );
}

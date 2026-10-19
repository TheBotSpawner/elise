import { financeBooks, financeReport, parseReportParams } from "@/application/finance-service";
import { todayIn } from "@/core/time";

import type { RouteLoader } from "../../../route-contract";

export const load = (async (auth, { search }) => {
  const input = parseReportParams(search);
  const [report, books] = await Promise.all([financeReport(auth, input), financeBooks(auth)]);
  return { report, books, today: todayIn(auth.profile.timezone) };
}) satisfies RouteLoader<unknown>;

export type FinanceReportProps = Awaited<ReturnType<typeof load>>;

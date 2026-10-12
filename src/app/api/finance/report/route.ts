import { NextResponse, type NextRequest } from "next/server";

import { getAuthContext } from "@/application/auth-context";
import { financeReport, parseReportParams } from "@/application/finance-service";
import { toPublicError } from "@/core/errors";
import { todayIn } from "@/core/time";
import { renderFinanceReportPdf } from "@/infrastructure/finance/report-pdf";
import { getT } from "@/lib/i18n/server";

export const dynamic = "force-dynamic";

/**
 * The financial report as a PDF download (ADR-052). Same filters and dataset as the preview
 * page and ELISE's chat answer; scoped to the signed-in user's workspace by the Finance tools.
 */
export async function GET(req: NextRequest) {
  const auth = await getAuthContext();
  if (!auth) return NextResponse.json({ error: "Sign in first" }, { status: 401 });
  try {
    const input = parseReportParams(Object.fromEntries(req.nextUrl.searchParams));
    const [report, { t, locale }] = await Promise.all([financeReport(auth, input), getT()]);
    const generated = new Intl.DateTimeFormat(locale === "es" ? "es-AR" : "en-US", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: auth.profile.timezone,
    }).format(new Date());
    const pdf = await renderFinanceReportPdf(report, t, locale, generated);
    const name = `elise-finanzas-${report.book ? `${report.book.replace(/[^\w-]+/g, "-")}-` : ""}${report.period.from}_${report.period.to}.pdf`;
    return new NextResponse(Buffer.from(pdf), {
      headers: {
        "content-type": "application/pdf",
        "content-disposition": `attachment; filename="${name}"`,
        "cache-control": "private, no-store",
        "x-elise-generated": todayIn(auth.profile.timezone),
      },
    });
  } catch (error) {
    const e = toPublicError(error);
    return NextResponse.json({ error: e.message, code: e.code }, { status: 400 });
  }
}

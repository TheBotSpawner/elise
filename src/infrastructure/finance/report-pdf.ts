import "server-only";

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";

import type { FinanceTransaction, GroupTotal } from "@/core/capabilities/finance";
import { shortDay } from "@/core/dates";
import { compareAmounts, formatMoney, toUnits } from "@/core/finance/money";
import type { FinanceReport } from "@/core/finance/report";
import type { Dictionary, Locale } from "@/lib/i18n";

/**
 * The financial report as a PDF (ADR-052), drawn from the same `FinanceReport` dataset as the
 * preview and ELISE's answer: this file only lays it out, it never computes totals. Standard
 * fonts (WinAnsi), so text is normalized to what they can encode.
 */

const A4 = { w: 595.28, h: 841.89 };
const M = 48;
const W = A4.w - M * 2;
const INK = rgb(0.043, 0.082, 0.098); // --fg
const MUTED = rgb(0.4, 0.45, 0.47);
const FAINT = rgb(0.62, 0.66, 0.68);
const LINE = rgb(0.88, 0.9, 0.91);
const ACCENT = rgb(0.039, 0.584, 0.651); // --accent
const SUCCESS = rgb(0, 0.533, 0.361);
const WARN = rgb(0.69, 0.424, 0.031);
const DANGER = rgb(0.75, 0.2, 0.2);

/** Characters the standard fonts can't encode → close equivalents (or dropped). */
function safe(text: string): string {
  return text
    .replace(/[\u2009\u202f\u00a0]/g, " ")
    .replace(/[\u2212\u2013\u2014]/g, "-")
    .replace(/\u2192/g, "->")
    .replace(/\u203a/g, ">")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\u2026/g, "...")
    .replace(/[^\x20-\x7e\u00a1-\u00ff]/g, "");
}

class Writer {
  page!: PDFPage;
  y = 0;
  pages: PDFPage[] = [];
  constructor(
    readonly doc: PDFDocument,
    readonly font: PDFFont,
    readonly bold: PDFFont,
  ) {
    this.newPage();
  }
  newPage() {
    this.page = this.doc.addPage([A4.w, A4.h]);
    this.pages.push(this.page);
    this.y = A4.h - M;
  }
  /** Room for `h` points, else a new page. */
  need(h: number) {
    if (this.y - h < M + 24) this.newPage();
  }
  fit(text: string, size: number, max: number, f = this.font): string {
    let s = safe(text);
    if (f.widthOfTextAtSize(s, size) <= max) return s;
    while (s.length > 1 && f.widthOfTextAtSize(`${s}...`, size) > max) s = s.slice(0, -1);
    return `${s}...`;
  }
  text(
    text: string,
    x: number,
    o: {
      size?: number;
      bold?: boolean;
      color?: ReturnType<typeof rgb>;
      max?: number;
      right?: boolean;
    } = {},
  ) {
    const size = o.size ?? 9.5;
    const f = o.bold ? this.bold : this.font;
    const s = this.fit(text, size, o.max ?? W, f);
    const dx = o.right ? -f.widthOfTextAtSize(s, size) : 0;
    this.page.drawText(s, { x: x + dx, y: this.y, size, font: f, color: o.color ?? INK });
  }
  /** Wrapped paragraph. */
  para(text: string, o: { size?: number; color?: ReturnType<typeof rgb> } = {}) {
    const size = o.size ?? 9.5;
    const words = safe(text).split(/\s+/);
    let line = "";
    for (const w of words) {
      const next = line ? `${line} ${w}` : w;
      if (this.font.widthOfTextAtSize(next, size) > W && line) {
        this.need(size + 4);
        this.text(line, M, { size, color: o.color });
        this.y -= size + 4;
        line = w;
      } else line = next;
    }
    if (line) {
      this.need(size + 4);
      this.text(line, M, { size, color: o.color });
      this.y -= size + 4;
    }
  }
  heading(text: string) {
    this.need(48);
    this.y -= 14;
    this.text(text.toUpperCase(), M, { size: 8.5, bold: true, color: ACCENT });
    this.y -= 6;
    this.page.drawLine({
      start: { x: M, y: this.y },
      end: { x: M + W, y: this.y },
      thickness: 0.6,
      color: LINE,
    });
    this.y -= 14;
  }
  rect(x: number, y: number, w: number, h: number, color: ReturnType<typeof rgb>) {
    if (w > 0 && h > 0) this.page.drawRectangle({ x, y, width: w, height: h, color });
  }
}

const ratio = (a: string, b: string) => {
  const whole = toUnits(b);
  return whole <= 0n ? 0 : Math.min(1, Number((toUnits(a) * 1000n) / whole) / 1000);
};

export async function renderFinanceReportPdf(
  report: FinanceReport,
  t: Dictionary,
  locale: Locale,
  generatedAt: string,
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(safe(`${t.finance.reports.title} ${report.period.from} - ${report.period.to}`));
  doc.setCreator("ELISE");
  const w = new Writer(
    doc,
    await doc.embedFont(StandardFonts.Helvetica),
    await doc.embedFont(StandardFonts.HelveticaBold),
  );
  const loc = locale === "es" ? "es-AR" : "en-US";
  const money = (a: string, c: string) => formatMoney(a, c, loc);
  const r = t.finance.reports;
  const has = (s: FinanceReport["sections"][number]) => report.sections.includes(s);
  const day = new Intl.DateTimeFormat(loc, {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
  const fmtDay = (iso: string) => day.format(new Date(`${iso}T00:00:00Z`));

  // ── Header ──
  w.text("ELISE", M, { size: 9, bold: true, color: ACCENT });
  w.text(r.generated(generatedAt), M + W, { size: 8.5, color: FAINT, right: true });
  w.y -= 26;
  w.text(r.title, M, { size: 20, bold: true });
  w.y -= 18;
  w.text(
    `${fmtDay(report.period.from)} - ${fmtDay(report.period.to)} · ${report.book ?? r.allBooks}`,
    M,
    { size: 10.5, color: MUTED },
  );
  w.y -= 10;
  const filters = [
    report.filter.type ? t.finance.types[report.filter.type] : null,
    report.filter.category,
    report.filter.subcategory,
    report.filter.account,
    report.filter.counterparty,
    report.filter.project,
  ].filter(Boolean);
  if (filters.length) {
    w.y -= 4;
    w.text(filters.join(" · "), M, { size: 9, color: FAINT });
    w.y -= 6;
  }

  // ── Summary / KPIs: one row per currency, never merged ──
  if (has("summary") || has("kpis")) {
    w.heading(r.sections.summary);
    if (!report.totals.length) w.para(r.noTransactions, { color: MUTED });
    const cols = [M, M + 70, M + 220, M + 370];
    if (report.totals.length) {
      w.text("", cols[0]!);
      w.text(t.finance.income, cols[1]! + 140, { size: 8.5, color: MUTED, right: true });
      w.text(t.finance.expenses, cols[2]! + 140, { size: 8.5, color: MUTED, right: true });
      w.text(t.finance.net, cols[3]! + 130, { size: 8.5, color: MUTED, right: true });
      w.y -= 16;
    }
    for (const c of report.totals) {
      w.need(18);
      w.text(c.currency, cols[0]!, { bold: true, size: 10.5 });
      w.text(money(c.income, c.currency), cols[1]! + 140, {
        size: 10.5,
        color: SUCCESS,
        right: true,
      });
      w.text(money(c.expense, c.currency), cols[2]! + 140, { size: 10.5, right: true });
      w.text(money(c.net, c.currency), cols[3]! + 130, {
        size: 10.5,
        bold: true,
        color: c.net.startsWith("-") ? DANGER : INK,
        right: true,
      });
      w.y -= 18;
    }
    const notes = [
      report.totals.length > 1 ? t.finance.separateCurrencies : "",
      report.excluded.pending ? t.finance.excluded(report.excluded.pending) : "",
      report.transfers ? t.finance.ws.transfers(report.transfers) : "",
      report.truncated ? r.truncated : "",
    ].filter(Boolean);
    if (notes.length) w.para(notes.join(" "), { size: 8.5, color: FAINT });
    if (report.converted) {
      const c = report.converted;
      w.y -= 4;
      w.need(18);
      w.text(`${r.reportingCurrency} ${c.currency}`, M, { size: 9, color: MUTED });
      w.text(
        `${t.finance.income} ${money(c.income, c.currency)} · ${t.finance.expenses} ${money(c.expense, c.currency)} · ${t.finance.net} ${money(c.net, c.currency)}`,
        M + W,
        { size: 9, right: true },
      );
      w.y -= 14;
      if (c.ratesUsed.length)
        w.para(
          `${r.ratesUsed}: ${c.ratesUsed.map((x) => `1 ${x.from} = ${x.rate} ${x.to} (${x.date})`).join("; ")}`,
          { size: 8.5, color: FAINT },
        );
      for (const u of c.unconverted)
        w.para(r.unconverted(u.currency, u.count), { size: 8.5, color: WARN });
    }
  }

  // ── Trend: income vs expense bars per currency ──
  if (has("trend")) {
    for (const s of report.trend) {
      if (s.keys.length < 2) continue;
      w.heading(`${t.finance.ws.trend} · ${s.currency}`);
      const h = 110;
      w.need(h + 30);
      const n = s.keys.length;
      const slot = W / n;
      const max = [...s.income, ...s.expense].reduce(
        (m, v) => (compareAmounts(v, m) > 0 ? v : m),
        "0",
      );
      const base = w.y - h;
      const bw = Math.max(1, Math.min(10, slot / 2 - 1.5));
      s.keys.forEach((k, i) => {
        const x = M + i * slot + slot / 2;
        w.rect(x - bw - 0.5, base, bw, h * ratio(s.income[i]!, max), SUCCESS);
        w.rect(x + 0.5, base, bw, h * ratio(s.expense[i]!, max), ACCENT);
        const every = Math.ceil(n / 12);
        if (i % every === 0) {
          const label = s.granularity === "month" ? k : shortDay(k);
          const lw = w.font.widthOfTextAtSize(label, 7);
          w.page.drawText(label, {
            x: x - lw / 2,
            y: base - 10,
            size: 7,
            font: w.font,
            color: FAINT,
          });
        }
      });
      w.page.drawLine({
        start: { x: M, y: base },
        end: { x: M + W, y: base },
        thickness: 0.5,
        color: LINE,
      });
      w.y = base - 24;
      w.rect(M, w.y + 1, 7, 7, SUCCESS);
      w.text(t.finance.income, M + 11, { size: 8.5, color: MUTED });
      w.rect(M + 80, w.y + 1, 7, 7, ACCENT);
      w.text(t.finance.expenses, M + 91, { size: 8.5, color: MUTED });
      w.text(`max ${money(max, s.currency)}`, M + W, { size: 8, color: FAINT, right: true });
      w.y -= 8;
    }
  }

  const bars = (title: string, groups: GroupTotal[], color = ACCENT) => {
    const currencies = [...new Set(groups.map((g) => g.currency))];
    for (const c of currencies) {
      const rows = groups.filter((g) => g.currency === c);
      if (!rows.length) continue;
      w.heading(`${title} · ${c}`);
      const max = rows.reduce((m, g) => (compareAmounts(g.total, m) > 0 ? g.total : m), "0");
      const whole = rows.reduce((u, g) => u + toUnits(g.total), 0n);
      for (const g of rows) {
        w.need(22);
        w.text(g.key, M, { max: 190 });
        w.rect(M + 200, w.y - 1, 200, 8, LINE);
        w.rect(M + 200, w.y - 1, 200 * ratio(g.total, max), 8, color);
        const pct = whole > 0n ? Number((toUnits(g.total) * 1000n) / whole) / 10 : 0;
        w.text(`${pct.toFixed(0)}%`, M + 432, { size: 8.5, color: MUTED, right: true });
        w.text(money(g.total, c), M + W, { size: 9.5, right: true });
        w.y -= 17;
      }
    }
  };

  if (has("categories")) {
    bars(t.finance.ws.expensesByCategory, report.expenseCategories);
    bars(t.finance.ws.incomeByCategory, report.incomeCategories, SUCCESS);
  }

  if (has("budgets") && report.budgets.length) {
    w.heading(`${t.finance.ws.tabs.budgets} · ${r.budgetMonths(report.budgetMonths)}`);
    for (const u of report.budgets) {
      w.need(30);
      w.text([u.category, u.subcategory, u.book].filter(Boolean).join(" · "), M, { max: 190 });
      const color = u.state === "over" ? DANGER : u.state === "warning" ? WARN : ACCENT;
      w.rect(M + 200, w.y - 1, 200, 8, LINE);
      w.rect(M + 200, w.y - 1, 200 * Math.min(1, u.percentTenths / 1000), 8, color);
      w.text(`${(u.percentTenths / 10).toFixed(0)}%`, M + 432, { size: 8.5, color, right: true });
      w.text(`${money(u.spent, u.currency)} / ${money(u.amount, u.currency)}`, M + W, {
        size: 9,
        right: true,
      });
      w.y -= 17;
    }
  }

  if (has("counterparties")) {
    bars(t.finance.ws.topClients, report.clients, SUCCESS);
    bars(t.finance.ws.topProviders, report.providers);
    bars(t.finance.ws.byProject, report.projects);
  }

  // ── Transactions ──
  if (has("transactions") && report.transactions.length) {
    w.heading(`${r.sections.transactions} (${report.transactions.length})`);
    const cols = { date: M, who: M + 58, cat: M + 205, acct: M + 320, amount: M + W };
    const header = () => {
      w.text(t.finance.date, cols.date, { size: 8, color: MUTED });
      w.text(t.finance.counterparty, cols.who, { size: 8, color: MUTED });
      w.text(t.finance.category, cols.cat, { size: 8, color: MUTED });
      w.text(t.finance.account, cols.acct, { size: 8, color: MUTED });
      w.text(t.finance.amount, cols.amount, { size: 8, color: MUTED, right: true });
      w.y -= 13;
    };
    header();
    const row = (tx: FinanceTransaction) => {
      const extra = [
        has("notes") ? tx.notes : null,
        has("receipts") && tx.receipt ? `${t.finance.ws.receipt}: ${tx.receipt}` : null,
      ].filter(Boolean) as string[];
      if (w.y - 14 - extra.length * 11 < M + 24) {
        w.newPage();
        header();
      }
      w.text(tx.date, cols.date, { size: 8.5, color: MUTED });
      const who = tx.counterparty || tx.description || "—";
      w.text(
        `${who}${tx.status === "pending" ? ` (${t.finance.statuses.pending})` : ""}${!report.book && tx.book ? ` · ${tx.book}` : ""}`,
        cols.who,
        { size: 8.5, max: 140 },
      );
      w.text(
        tx.type === "transfer"
          ? t.finance.types.transfer
          : [tx.category, tx.subcategory].filter(Boolean).join(" > ") || "—",
        cols.cat,
        { size: 8.5, max: 110, color: MUTED },
      );
      w.text(
        tx.type === "transfer"
          ? `${tx.account ?? "—"} -> ${tx.toAccount ?? "—"}`
          : (tx.account ?? tx.paymentMethod ?? "—"),
        cols.acct,
        { size: 8.5, max: 95, color: MUTED },
      );
      const sign = tx.type === "income" ? "+" : tx.type === "expense" ? "-" : "";
      w.text(`${sign}${money(tx.amount, tx.currency)}`, cols.amount, {
        size: 8.5,
        right: true,
        color: tx.type === "income" ? SUCCESS : INK,
      });
      w.y -= 12;
      for (const e of extra) {
        w.text(e, cols.who, { size: 7.5, color: FAINT, max: W - 58 });
        w.y -= 11;
      }
      w.page.drawLine({
        start: { x: M, y: w.y + 7 },
        end: { x: M + W, y: w.y + 7 },
        thickness: 0.3,
        color: LINE,
      });
    };
    report.transactions.forEach(row);
  }

  // ── Footer on every page ──
  const sources = report.sources
    .filter((s) => s.included)
    .map((s) => s.name)
    .join(", ");
  w.pages.forEach((p, i) => {
    const footer = safe(
      `${sources ? `${t.finance.sources}: ${sources} · ` : ""}${locale === "es" ? "Calculado por ELISE, sin conversiones implícitas" : "Computed by ELISE, no implicit conversions"}`,
    );
    p.drawText(w.fit(footer, 7.5, W - 60), { x: M, y: 28, size: 7.5, font: w.font, color: FAINT });
    const n = `${i + 1} / ${w.pages.length}`;
    p.drawText(n, {
      x: M + W - w.font.widthOfTextAtSize(n, 7.5),
      y: 28,
      size: 7.5,
      font: w.font,
      color: FAINT,
    });
  });
  return doc.save();
}

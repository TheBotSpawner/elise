"use client";

import { AlertTriangle, ChevronDown, Sparkles } from "lucide-react";
import { useState } from "react";

import { Label, Select } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import type { FinanceField, FinanceMapping, FinancePreview } from "@/core/finance/import";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

import { COMMON_CURRENCIES, useDay, useMoney } from "./format";

const MAIN: FinanceField[] = [
  "date",
  "type",
  "amount",
  "currency",
  "description",
  "counterparty",
  "category",
  "account",
  "project",
  "status",
];
const EXTRA: FinanceField[] = [
  "incomeAmount",
  "expenseAmount",
  "subcategory",
  "paymentMethod",
  "notes",
  "reference",
];

/** Field → column, plus how to read amounts, dates, missing currencies and types. */
export function MappingEditor({
  headers,
  sample,
  mapping,
  fromAI,
  onChange,
}: {
  headers: string[];
  sample: string[][];
  mapping: FinanceMapping;
  fromAI: FinanceField[];
  onChange: (m: FinanceMapping) => void;
}) {
  const { t } = useI18n();
  const w = t.finance.wizard;
  const [more, setMore] = useState(() => EXTRA.some((f) => mapping.columns[f] !== undefined));
  const setColumn = (field: FinanceField, value: string) => {
    const columns = { ...mapping.columns };
    if (value === "") delete columns[field];
    else {
      const index = Number(value);
      // One column feeds one field.
      for (const f of Object.keys(columns) as FinanceField[])
        if (columns[f] === index) delete columns[f];
      columns[field] = index;
    }
    onChange({ ...mapping, columns });
  };
  const option = (i: number) => {
    const example = sample.find((r) => r[i]?.trim())?.[i];
    return `${headers[i] || `#${i + 1}`}${example ? ` · ${example.slice(0, 24)}` : ""}`;
  };
  const row = (field: FinanceField) => (
    <div
      key={field}
      className="grid grid-cols-1 items-center gap-1.5 sm:grid-cols-[13rem_minmax(0,1fr)] sm:gap-3"
    >
      <Label htmlFor={`map-${field}`} className="flex items-center gap-1.5 text-[13px] text-fg">
        {w.fields[field]}
        {fromAI.includes(field) && mapping.columns[field] !== undefined && (
          <span className="flex items-center gap-1 text-[11.5px] font-normal text-accent-text">
            <Sparkles className="size-3" aria-hidden />
            {w.suggested}
          </span>
        )}
      </Label>
      <Select
        id={`map-${field}`}
        value={mapping.columns[field] === undefined ? "" : String(mapping.columns[field])}
        onChange={(e) => setColumn(field, e.target.value)}
      >
        <option value="">{w.notUsed}</option>
        {headers.map((_, i) => (
          <option key={i} value={i}>
            {option(i)}
          </option>
        ))}
      </Select>
    </div>
  );

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-3">
        <div className="flex flex-col gap-0.5">
          <h2 className="type-label text-faint">{w.columns}</h2>
          <p className="text-[13px] text-muted">{w.columnsHint}</p>
        </div>
        <div className="flex flex-col gap-2.5">{MAIN.map(row)}</div>
        <button
          type="button"
          aria-expanded={more}
          onClick={() => setMore(!more)}
          className="flex items-center gap-1.5 self-start text-[13px] text-muted hover:text-fg"
        >
          <ChevronDown
            className={cn("size-4 transition-transform", more && "rotate-180")}
            aria-hidden
          />
          {more ? t.finance.fewerDetails : t.finance.moreDetails}
        </button>
        {more && <div className="flex flex-col gap-2.5">{EXTRA.map(row)}</div>}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="type-label text-faint">{w.formats}</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="map-number">{w.numberFormat}</Label>
            <Select
              id="map-number"
              value={mapping.numberFormat ?? "auto"}
              onChange={(e) =>
                onChange({
                  ...mapping,
                  numberFormat:
                    e.target.value === "auto"
                      ? null
                      : (e.target.value as FinanceMapping["numberFormat"]),
                })
              }
            >
              {(["auto", "comma_decimal", "dot_decimal"] as const).map((f) => (
                <option key={f} value={f}>
                  {w.numberFormats[f]}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="map-date">{w.dateFormat}</Label>
            <Select
              id="map-date"
              value={mapping.dateFormat ?? "auto"}
              onChange={(e) =>
                onChange({
                  ...mapping,
                  dateFormat:
                    e.target.value === "auto"
                      ? null
                      : (e.target.value as FinanceMapping["dateFormat"]),
                })
              }
            >
              {(["auto", "dmy", "mdy", "ymd"] as const).map((f) => (
                <option key={f} value={f}>
                  {w.dateFormats[f]}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="map-currency">{w.defaultCurrency}</Label>
            <Select
              id="map-currency"
              value={mapping.defaultCurrency ?? ""}
              onChange={(e) => onChange({ ...mapping, defaultCurrency: e.target.value || null })}
            >
              <option value="">{t.finance.notSet}</option>
              {COMMON_CURRENCIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="map-type">{w.defaultType}</Label>
            <Select
              id="map-type"
              value={mapping.defaultType ?? "none"}
              onChange={(e) =>
                onChange({
                  ...mapping,
                  defaultType:
                    e.target.value === "none" ? null : (e.target.value as "income" | "expense"),
                })
              }
            >
              {(["none", "expense", "income"] as const).map((f) => (
                <option key={f} value={f}>
                  {w.defaultTypes[f]}
                </option>
              ))}
            </Select>
          </div>
        </div>
      </section>

      {sample.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="type-label text-faint">{w.sample}</h2>
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full min-w-max text-left text-[12.5px]">
              <thead className="bg-surface-2 text-muted">
                <tr>
                  {headers.map((h, i) => (
                    <th key={i} className="px-3 py-2 font-medium whitespace-nowrap">
                      {h || `#${i + 1}`}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="font-mono">
                {sample.slice(0, 3).map((r, n) => (
                  <tr key={n} className="border-t border-border">
                    {headers.map((_, i) => (
                      <td key={i} className="max-w-48 truncate px-3 py-1.5 whitespace-nowrap">
                        {r[i] ?? ""}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}

/** Everything the user reviews before anything is written. Invalid rows are never hidden. */
export function PreviewPanel({
  preview,
  includeDuplicates,
  onIncludeDuplicates,
  notes = [],
}: {
  preview: FinancePreview;
  includeDuplicates?: boolean;
  onIncludeDuplicates?: (v: boolean) => void;
  notes?: string[];
}) {
  const { t } = useI18n();
  const w = t.finance.wizard;
  const money = useMoney();
  const day = useDay();
  const [showIssues, setShowIssues] = useState(false);
  return (
    <section
      className="flex flex-col gap-4 rounded-2xl border border-border bg-surface px-5 py-4"
      aria-live="polite"
    >
      <p className="flex flex-wrap gap-x-4 gap-y-1 text-[14px]">
        <span className="font-medium">{w.detected(preview.totalRows)}</span>
        <span className="text-success">{w.ready(preview.willImport)}</span>
        {preview.invalid > 0 && (
          <span className="text-approval-text">{w.attention(preview.invalid)}</span>
        )}
      </p>
      {preview.duplicates > 0 && (
        <div className="flex flex-col gap-2 text-[13.5px]">
          <p className="text-muted">{w.duplicates(preview.duplicates)}</p>
          {onIncludeDuplicates && (
            <label className="flex items-center gap-3">
              <Switch
                checked={Boolean(includeDuplicates)}
                onCheckedChange={onIncludeDuplicates}
                aria-label={w.includeDuplicates}
              />
              {w.includeDuplicates}
            </label>
          )}
        </div>
      )}
      {preview.repeatedInFile > 0 && (
        <p className="text-[13px] text-faint">{w.repeated(preview.repeatedInFile)}</p>
      )}
      {[...preview.needs.map((n) => w.needs[n]), ...notes].map((n) => (
        <p key={n} className="flex items-start gap-2 text-[13.5px] text-approval-text">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
          {n}
        </p>
      ))}
      {preview.byCurrency.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <h3 className="text-[12.5px] text-faint">{w.byCurrency}</h3>
          <table className="w-full text-[13.5px]">
            <tbody className="font-mono text-[13px]">
              {preview.byCurrency.map((c) => (
                <tr key={c.currency} className="border-t border-border first:border-t-0">
                  <td className="py-1.5 font-sans font-medium">{c.currency}</td>
                  <td className="py-1.5 text-right text-success">
                    +{money(c.income, c.currency)}{" "}
                    <span className="text-faint">({c.incomeCount})</span>
                  </td>
                  <td className="py-1.5 text-right">
                    −{money(c.expense, c.currency)}{" "}
                    <span className="text-faint">({c.expenseCount})</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {preview.sample.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <h3 className="text-[12.5px] text-faint">{w.sample}</h3>
          <ul className="flex flex-col gap-1.5 text-[13.5px]">
            {preview.sample.slice(0, 5).map((s) => (
              <li key={s.row} className="grid grid-cols-[3.5rem_minmax(0,1fr)_auto] gap-3">
                <span className="font-mono text-[12px] text-faint">{day(s.date)}</span>
                <span className="truncate">
                  {s.counterparty || s.description || s.category || "—"}
                  {s.category && <span className="text-faint"> · {s.category}</span>}
                </span>
                <span
                  className={cn("font-mono text-[13px]", s.type === "income" && "text-success")}
                >
                  {s.type === "income" ? "+" : "−"}
                  {money(s.amount, s.currency)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {preview.issues.length > 0 && (
        <div className="flex flex-col gap-2">
          <button
            type="button"
            aria-expanded={showIssues}
            onClick={() => setShowIssues(!showIssues)}
            className="flex items-center gap-1.5 self-start text-[13.5px] text-approval-text hover:underline"
          >
            <ChevronDown
              className={cn("size-4 transition-transform", showIssues && "rotate-180")}
              aria-hidden
            />
            {showIssues ? w.hideIssues : `${w.reviewIssues} (${preview.invalid})`}
          </button>
          {showIssues && (
            <ul className="flex max-h-72 flex-col gap-1.5 overflow-y-auto text-[13px]">
              {preview.issues.map((i) => (
                <li key={i.row} className="flex flex-col gap-0.5 rounded-xl bg-surface-2 px-3 py-2">
                  <span className="font-medium">
                    {w.row(i.row)} · {i.issues.map((x) => w.issue[x]).join(", ")}
                  </span>
                  <span className="truncate font-mono text-[12px] text-faint">
                    {i.cells.filter(Boolean).join(" · ")}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

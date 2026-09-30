"use client";

import { motion, type MotionProps } from "motion/react";

import type { StructuredSourceRef, ToolDisplay } from "@/core/agents/tools";
import type { StructuredRecord } from "@/core/capabilities/structured";
import { formatValue } from "@/features/structured/setup";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

type D<K extends ToolDisplay["kind"]> = Extract<ToolDisplay, { kind: K }>;

const CARD =
  "flex flex-col gap-2.5 rounded-2xl border border-border bg-surface px-4 py-3.5 md:px-5 md:py-[18px]";

function Provenance({ source, extra }: { source: StructuredSourceRef; extra?: string }) {
  return (
    <span className="type-label text-faint">
      Notion · {source.name}
      {extra ? ` · ${extra}` : ""}
    </span>
  );
}

/** Up to three of the most telling mapped fields next to the title. */
function Line({ record, source }: { record: StructuredRecord; source: StructuredSourceRef }) {
  const fields = source.fields
    .filter(
      (f) =>
        !f.isTitle &&
        !f.broken &&
        record.values[f.key] !== null &&
        record.values[f.key] !== undefined,
    )
    .sort((a, b) => rank(a.key) - rank(b.key))
    .slice(0, 3);
  const body = (
    <>
      <span className="block truncate text-[14px]">{record.title}</span>
      {fields.length > 0 && (
        <span className="block truncate text-[12.5px] text-faint">
          {fields.map((f) => `${f.label}: ${formatValue(record.values[f.key])}`).join(" · ")}
        </span>
      )}
    </>
  );
  return record.url ? (
    <a href={record.url} target="_blank" rel="noreferrer" className="block hover:text-accent-text">
      {body}
    </a>
  ) : (
    body
  );
}

const RANK = ["status", "due_date", "priority", "client", "owner"];
const rank = (key: string) => (RANK.includes(key) ? RANK.indexOf(key) : 99);

export function StructuredRecordsCard({
  display,
  rise,
}: {
  display: D<"structured_records">;
  rise: MotionProps;
}) {
  const { t } = useI18n();
  return (
    <motion.section {...rise} aria-label={display.source.name} className={CARD}>
      <Provenance source={display.source} extra={t.structured.records(display.records.length)} />
      {display.records.length === 0 ? (
        <p className="text-[14px] text-muted">—</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {display.records.slice(0, 12).map((r) => (
            <li key={r.id}>
              <Line record={r} source={display.source} />
            </li>
          ))}
        </ul>
      )}
      {display.hasMore && <span className="text-[12px] text-faint">{t.structured.more}</span>}
    </motion.section>
  );
}

export function StructuredRecordCard({
  display,
  rise,
}: {
  display: D<"structured_record">;
  rise: MotionProps;
}) {
  const { t } = useI18n();
  return (
    <motion.section {...rise} aria-label={display.source.name} className={CARD}>
      <Provenance source={display.source} extra={t.structured.change[display.change]} />
      <div className={cn(display.change === "archived" && "line-through opacity-60")}>
        <Line record={display.record} source={display.source} />
      </div>
    </motion.section>
  );
}

export function StructuredSourcesCard({
  display,
  rise,
}: {
  display: D<"structured_sources">;
  rise: MotionProps;
}) {
  const { t } = useI18n();
  if (!display.sources.length) return null;
  return (
    <motion.section {...rise} aria-label={t.structured.title} className={CARD}>
      <span className="type-label text-faint">{t.structured.title}</span>
      <ul className="flex flex-col gap-1.5 text-[14px]">
        {display.sources.map((s) => (
          <li key={s.id} className="flex items-baseline justify-between gap-3">
            <span className="truncate">{s.name}</span>
            <span className="shrink-0 text-[12.5px] text-faint">Notion · {s.account}</span>
          </li>
        ))}
      </ul>
    </motion.section>
  );
}

export function StructuredBulkCard({
  display,
  rise,
}: {
  display: D<"structured_bulk_preview">;
  rise: MotionProps;
}) {
  const { t } = useI18n();
  return (
    <motion.section {...rise} aria-label={display.source.name} className={CARD}>
      <Provenance source={display.source} extra={t.structured.bulk(display.count)} />
      <p className="text-[14px]">{display.change}</p>
      <ul className="flex flex-col gap-1.5">
        {display.sample.map((r) => (
          <li key={r.id}>
            <Line record={r} source={display.source} />
          </li>
        ))}
      </ul>
      {display.count > display.sample.length && (
        <span className="text-[12px] text-faint">+{display.count - display.sample.length}</span>
      )}
    </motion.section>
  );
}

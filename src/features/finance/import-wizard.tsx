"use client";

import { ChevronDown, Loader2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

import type { ImportInspection, ImportPreviewView } from "@/application/finance-import";
import { Button, buttonVariants } from "@/components/ui/button";
import { Label, Select } from "@/components/ui/input";
import type { EntityDecision, FinanceMapping } from "@/core/finance/import";
import { errorText } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

import {
  cancelImportAction,
  confirmImportAction,
  inspectImportAction,
  previewImportAction,
} from "./actions";
import { ImportProgress, ImportUnderstanding } from "./import-review";
import { FileSettings, MappingEditor, PreviewPanel } from "./mapping";

type Stage =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "mapping" }
  | { kind: "importing" };

/**
 * One import (ADR-073): ELISE reads the file and says what it understood (columns, accounts,
 * categories), asking only what it can't decide; the user corrects what they want and starts
 * it; the import runs (in the background when large) and its progress and result show here.
 * Nothing is written until "Import N".
 */
export function ImportWizard({ importId, status }: { importId: string; status: string }) {
  const { t } = useI18n();
  const w = t.finance.wizard;
  const router = useRouter();
  const [stage, setStage] = useState<Stage>(
    status === "importing" || status === "completed" ? { kind: "importing" } : { kind: "loading" },
  );
  const [columnsOpen, setColumnsOpen] = useState(false);
  const [inspection, setInspection] = useState<ImportInspection | null>(null);
  const [mapping, setMapping] = useState<FinanceMapping | null>(null);
  const [preview, setPreview] = useState<ImportPreviewView | null>(null);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const load = (sheet?: string) =>
    startTransition(async () => {
      setPreview(null);
      const r = await inspectImportAction(importId, sheet);
      if (!r.ok) {
        setStage({ kind: "error", message: errorText(t, r.error) });
        return;
      }
      setInspection(r.value);
      setMapping(r.value.mapping);
      setStage({ kind: "mapping" });
      // What ELISE understood, right away: no separate "preview" step to find.
      const p = await previewImportAction(importId, r.value.mapping);
      if (p.ok) setPreview({ ...p.value, sameFile: r.value.sameFile });
      else setError(errorText(t, p.error));
    });

  useEffect(() => {
    if (status === "uploading" || status === "uploaded") load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- inspect once on arrival
  }, []);

  const runPreview = (m: FinanceMapping) =>
    startTransition(async () => {
      setError(null);
      const r = await previewImportAction(importId, m);
      if (!r.ok) setError(errorText(t, r.error));
      else setPreview({ ...r.value, sameFile: inspection?.sameFile ?? null });
    });

  /** One decision per name ("Cash" is the user's "Efectivo"); every row follows (ADR-073). */
  const decide = (kind: "accounts" | "categories", key: string, decision: EntityDecision) => {
    if (!mapping) return;
    const next = {
      ...mapping,
      entities: { ...mapping.entities, [kind]: { ...mapping.entities[kind], [key]: decision } },
    };
    setMapping(next);
    runPreview(next);
  };

  if (stage.kind === "loading")
    return (
      <p className="flex items-center gap-2 text-[14px] text-muted" aria-live="polite">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        {w.reading}
      </p>
    );
  if (stage.kind === "error")
    return (
      <div className="flex flex-col items-start gap-3">
        <p role="alert" className="text-[14px] text-danger-text">
          {stage.message}
        </p>
        <Link href="/my-elise/finance/sources" className={buttonVariants({ variant: "secondary" })}>
          {t.finance.sourcesTitle}
        </Link>
      </div>
    );
  if (stage.kind === "importing") return <ImportProgress importId={importId} />;

  if (!inspection || !mapping) return null;
  const notes = [
    ...(preview?.sameFile ? [w.sameFile] : []),
    ...(preview?.connectedSource ? [w.connectedSource(preview.connectedSource)] : []),
  ];
  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <p className="text-[14px] text-muted">
          {inspection.label} · {w.detected(inspection.rows)}
          {inspection.format && <> · {w.format(inspection.format.label)}</>}
        </p>
        {inspection.sheets.length > 1 && (
          <div className="flex items-center gap-2">
            <Label htmlFor="import-sheet">{w.sheet}</Label>
            <Select
              id="import-sheet"
              value={inspection.sheet}
              disabled={pending}
              onChange={(e) => load(e.target.value)}
              className="w-auto"
            >
              {inspection.sheets.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          </div>
        )}
      </div>

      <FileSettings
        headers={inspection.headers}
        mapping={mapping}
        onChange={(m) => {
          setMapping(m);
          runPreview(m);
        }}
      />

      {preview ? (
        <ImportUnderstanding
          inspection={inspection}
          preview={preview}
          mapping={mapping}
          onDecide={decide}
        />
      ) : (
        <p className="flex items-center gap-2 text-[14px] text-muted" aria-live="polite">
          <Loader2 className="size-4 animate-spin" aria-hidden />
          {w.previewing}
        </p>
      )}

      <div className="flex flex-col gap-4">
        <button
          type="button"
          aria-expanded={columnsOpen}
          onClick={() => setColumnsOpen(!columnsOpen)}
          className="flex items-center gap-1.5 self-start text-[12.5px] font-medium tracking-wide text-faint uppercase hover:text-fg"
        >
          <ChevronDown
            className={cn("size-4 transition-transform", columnsOpen && "rotate-180")}
            aria-hidden
          />
          {w.columns}
        </button>
        {columnsOpen && (
          <MappingEditor
            headers={inspection.headers}
            sample={inspection.sample}
            mapping={mapping}
            fromAI={inspection.fromAI}
            onChange={(m) => {
              setMapping(m);
              setPreview(null);
            }}
          />
        )}
      </div>

      {preview ? (
        <>
          <PreviewPanel
            preview={preview}
            includeDuplicates={mapping.includeDuplicates}
            onIncludeDuplicates={(v) => {
              const next = { ...mapping, includeDuplicates: v };
              setMapping(next);
              runPreview(next);
            }}
            notes={notes}
          />
          {(preview.creates.categories.length > 0 || preview.creates.accounts.length > 0) && (
            <div className="flex flex-col gap-1 text-[13px] text-muted">
              <span>{w.creates}</span>
              {preview.creates.categories.length > 0 && (
                <span>{w.newCategories(preview.creates.categories.join(", "))}</span>
              )}
              {preview.creates.accounts.length > 0 && (
                <span>{w.newAccounts(preview.creates.accounts.join(", "))}</span>
              )}
            </div>
          )}
        </>
      ) : null}

      {error && (
        <p role="alert" className="text-[14px] text-danger-text">
          {error}
        </p>
      )}
      <div className="sticky bottom-0 -mx-4 flex flex-wrap items-center justify-end gap-2 border-t border-border bg-bg/90 px-4 py-3 backdrop-blur md:-mx-0 md:rounded-2xl md:border">
        <Button
          variant="ghost"
          className="mr-auto"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              await cancelImportAction(importId);
              router.push("/my-elise/finance/sources");
            })
          }
        >
          {t.finance.cancel}
        </Button>
        <Button variant="secondary" disabled={pending} onClick={() => runPreview(mapping)}>
          {pending && !preview ? w.previewing : w.preview}
        </Button>
        {preview && (
          <Button
            disabled={pending || preview.willImport === 0}
            onClick={() =>
              startTransition(async () => {
                setError(null);
                const r = await confirmImportAction(importId);
                if (!r.ok) {
                  // Keep the mapping: the user can fix what's wrong and try again.
                  setError(errorText(t, r.error));
                  return;
                }
                setStage({ kind: "importing" });
              })
            }
          >
            {preview.willImport === 0 ? w.noValid : w.importN(preview.willImport)}
          </Button>
        )}
      </div>
    </div>
  );
}

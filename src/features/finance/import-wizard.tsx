"use client";

import { CheckCircle2, Loader2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

import type { ImportInspection, ImportPreviewView } from "@/application/finance-import";
import { Button, buttonVariants } from "@/components/ui/button";
import { Label, Select } from "@/components/ui/input";
import type { FinanceMapping } from "@/core/finance/import";
import { useI18n } from "@/lib/i18n/client";

import {
  cancelImportAction,
  confirmImportAction,
  inspectImportAction,
  previewImportAction,
} from "./actions";
import { MappingEditor, PreviewPanel } from "./mapping";

type Stage =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "mapping" }
  | { kind: "importing"; background: boolean }
  | { kind: "done"; imported: number };

/**
 * One import, step by step: columns (with ELISE's suggestion) → preview of every row →
 * confirm. Nothing is written until "Import N".
 */
export function ImportWizard({ importId, status }: { importId: string; status: string }) {
  const { t } = useI18n();
  const w = t.finance.wizard;
  const router = useRouter();
  const [stage, setStage] = useState<Stage>(
    status === "importing" ? { kind: "importing", background: true } : { kind: "loading" },
  );
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
        setStage({ kind: "error", message: r.error.message || t.errors.codes[r.error.code] });
        return;
      }
      setInspection(r.value);
      setMapping(r.value.mapping);
      setStage({ kind: "mapping" });
    });

  useEffect(() => {
    if (status === "uploading" || status === "uploaded") load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- inspect once on arrival
  }, []);

  // A background import finishes on its own; follow its status.
  useEffect(() => {
    if (stage.kind !== "importing" || !stage.background) return;
    const timer = setInterval(() => router.refresh(), 4000);
    return () => clearInterval(timer);
  }, [stage, router]);
  useEffect(() => {
    if (status === "completed" && stage.kind === "importing")
      router.push("/my-elise/finance/sources");
  }, [status, stage.kind, router]);

  const runPreview = (m: FinanceMapping) =>
    startTransition(async () => {
      setError(null);
      const r = await previewImportAction(importId, m);
      if (!r.ok) setError(r.error.message || t.errors.codes[r.error.code]);
      else setPreview({ ...r.value, sameFile: inspection?.sameFile ?? null });
    });

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
  if (stage.kind === "importing")
    return (
      <p className="flex items-center gap-2 text-[14px] text-muted" aria-live="polite">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        {stage.background ? w.background : w.importing}
      </p>
    );
  if (stage.kind === "done")
    return (
      <div className="flex flex-col items-start gap-4" aria-live="polite">
        <p className="flex items-center gap-2 text-[16px]">
          <CheckCircle2 className="size-5 text-success" aria-hidden />
          {w.done(stage.imported)}
        </p>
        <Link href="/my-elise/finance" className={buttonVariants()}>
          {w.openFinance}
        </Link>
      </div>
    );

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
                setStage({ kind: "importing", background: false });
                const r = await confirmImportAction(importId);
                if (!r.ok) {
                  // Keep the mapping: the user can fix what's wrong and try again.
                  setStage({ kind: "mapping" });
                  setError(r.error.message || t.errors.codes[r.error.code]);
                  return;
                }
                if (r.value.status === "completed")
                  setStage({ kind: "done", imported: r.value.imported });
                else setStage({ kind: "importing", background: true });
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

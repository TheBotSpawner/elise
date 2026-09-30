"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import {
  buildPreview,
  IMPORT_FIELDS,
  type ImportKind,
  type ImportPreview,
} from "@/core/native/import";
import { useI18n } from "@/lib/i18n/client";

import { commitImportAction, previewImportAction } from "./actions";

/**
 * Upload CSV → ELISE proposes a column mapping → preview with per-row problems → confirm.
 * Only valid rows are created; skipped rows are listed with the reason.
 */
export function ImportPanel({ kind, onDone }: { kind: ImportKind; onDone: () => void }) {
  const { t } = useI18n();
  const router = useRouter();
  const [csv, setCsv] = useState<string | null>(null);
  const [listName, setListName] = useState("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [pending, startTransition] = useTransition();

  function load(file: File | undefined) {
    if (!file) return;
    startTransition(async () => {
      const text = await file.text();
      setCsv(text);
      const r = await previewImportAction(kind, text, listName || undefined);
      if (!r.ok) return void toast.error(t.errors.codes[r.error.code]);
      setPreview(r.value);
      setMapping(r.value.mapping);
    });
  }

  function remap(next: Record<string, string>) {
    setMapping(next);
    // Re-validate locally with the chosen mapping (deterministic; nothing is written).
    if (csv) setPreview(buildPreview(csv, kind, next, listName || undefined));
  }

  return (
    <div className="flex flex-col gap-4 rounded-2xl border border-border bg-surface p-5">
      <div>
        <p className="font-medium">{t.native.import.title}</p>
        <p className="text-[13px] text-muted">{t.native.import.hint}</p>
      </div>
      {kind === "lists" && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="import-list">{t.native.import.listName}</Label>
          <Input
            id="import-list"
            maxLength={120}
            value={listName}
            onChange={(e) => setListName(e.target.value)}
          />
        </div>
      )}
      <input
        type="file"
        accept=".csv,text/csv"
        onChange={(e) => load(e.target.files?.[0])}
        className="text-[13px]"
      />
      {preview && (
        <>
          <div className="grid gap-2 sm:grid-cols-2">
            {IMPORT_FIELDS[kind].map((field) => (
              <div key={field.key} className="flex flex-col gap-1">
                <Label htmlFor={`map-${field.key}`}>
                  {field.key}
                  {field.required && " *"}
                </Label>
                <Select
                  id={`map-${field.key}`}
                  value={mapping[field.key] ?? ""}
                  onChange={(e) => {
                    const next = { ...mapping };
                    if (e.target.value) next[field.key] = e.target.value;
                    else delete next[field.key];
                    remap(next);
                  }}
                >
                  <option value="">{t.native.import.notMapped}</option>
                  {preview.headers.map((h) => (
                    <option key={h} value={h}>
                      {h}
                    </option>
                  ))}
                </Select>
              </div>
            ))}
          </div>
          <p className="text-[13.5px]">
            {t.native.import.preview(preview.valid.length, preview.invalid.length)}
          </p>
          {preview.invalid.length > 0 && (
            <ul className="max-h-40 overflow-y-auto text-[12.5px] text-approval-text">
              {preview.invalid.slice(0, 50).map((r) => (
                <li key={r.row}>
                  {t.native.import.row(r.row)}: {r.errors.join("; ")}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onDone}>
          {t.native.cancel}
        </Button>
        <Button
          disabled={pending || !preview || preview.valid.length === 0 || !csv}
          onClick={() =>
            startTransition(async () => {
              const r = await commitImportAction(kind, csv!, mapping, listName || undefined);
              if (!r.ok) return void toast.error(t.errors.codes[r.error.code]);
              toast.success(t.native.import.done(r.value.created, r.value.failed.length));
              onDone();
              router.refresh();
            })
          }
        >
          {t.native.import.confirm(preview?.valid.length ?? 0)}
        </Button>
      </div>
    </div>
  );
}

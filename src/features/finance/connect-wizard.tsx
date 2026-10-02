"use client";

import { FileSpreadsheet, Loader2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";

import type { FinanceGoogleAccount, TabInspection } from "@/application/finance-sources";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import type { FinanceMapping, FinancePreview } from "@/core/finance/import";
import { errorText } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

import {
  connectSheetAction,
  inspectTabAction,
  openSpreadsheetAction,
  prepareSheetsImportAction,
  previewTabAction,
  recentSpreadsheetsAction,
} from "./actions";
import { MappingEditor, PreviewPanel } from "./mapping";

type Mode = "connect" | "import";
type Sheet = {
  id: string;
  title: string;
  tabs: { sheetId: number; title: string; rows: number }[];
};

/**
 * Google Sheets for Finance: account → spreadsheet → tab, then either connect it (the sheet
 * stays the source of truth; map columns, preview, confirm) or import it into ELISE (the
 * import flow maps and previews every row before anything is written).
 */
export function ConnectSheetWizard({
  accounts,
  initialMode,
}: {
  accounts: FinanceGoogleAccount[];
  initialMode: Mode;
}) {
  const { t } = useI18n();
  const w = t.finance.wizard;
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const ready = accounts.filter((a) => a.ready);
  const [mode, setMode] = useState<Mode>(initialMode);
  const [connectionId, setConnectionId] = useState(ready[0]?.connectionId ?? "");
  const [recent, setRecent] = useState<{ id: string; name: string }[] | null>(null);
  const [link, setLink] = useState("");
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [tab, setTab] = useState<TabInspection | null>(null);
  const [mapping, setMapping] = useState<FinanceMapping | null>(null);
  const [preview, setPreview] = useState<FinancePreview | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const account = ready.find((a) => a.connectionId === connectionId);

  useEffect(() => {
    if (!account?.canBrowse) return;
    let live = true;
    void recentSpreadsheetsAction(account.connectionId).then((r) => {
      if (live && r.ok) setRecent(r.value);
    });
    return () => {
      live = false;
    };
  }, [account?.connectionId, account?.canBrowse]);

  const fail = (e: { message: string; code: string }) => setError(errorText(t, e));

  const open = (idOrLink: string) =>
    startTransition(async () => {
      setError(null);
      setTab(null);
      setPreview(null);
      const r = await openSpreadsheetAction(connectionId, idOrLink);
      if (!r.ok) return fail(r.error);
      setSheet(r.value);
    });

  const pickTab = (sheetId: number) =>
    startTransition(async () => {
      if (!sheet) return;
      setError(null);
      setPreview(null);
      if (mode === "import") {
        const r = await prepareSheetsImportAction({
          connectionId,
          spreadsheetId: sheet.id,
          sheetId,
        });
        if (!r.ok) return fail(r.error);
        router.push(`/my-elise/finance/import/${r.value.importId}`);
        return;
      }
      const r = await inspectTabAction({ connectionId, spreadsheetId: sheet.id, sheetId });
      if (!r.ok) return fail(r.error);
      setTab(r.value);
      setMapping(r.value.mapping);
      setName(`${r.value.title} · ${r.value.tab}`);
    });

  const runPreview = (m: FinanceMapping) =>
    startTransition(async () => {
      if (!tab) return;
      setError(null);
      const r = await previewTabAction({
        connectionId,
        spreadsheetId: tab.spreadsheetId,
        sheetId: tab.sheetId,
        mapping: m,
      });
      if (!r.ok) return fail(r.error);
      setPreview(r.value);
    });

  if (!ready.length) {
    return (
      <div className="flex flex-col items-start gap-3 rounded-2xl border border-dashed border-border px-5 py-5">
        <p className="text-[14px] text-muted">{w.noGoogle}</p>
        <Link href="/connections" className={buttonVariants()}>
          {w.enableSheets}
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <div role="radiogroup" aria-label={t.finance.sources} className="grid gap-2 sm:grid-cols-2">
        {(["connect", "import"] as const).map((m) => (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={mode === m}
            onClick={() => {
              setMode(m);
              setTab(null);
              setPreview(null);
            }}
            className={cn(
              "flex flex-col gap-1 rounded-2xl border px-4 py-3 text-left transition-colors",
              mode === m
                ? "border-accent bg-accent-soft"
                : "border-border hover:border-border-strong",
            )}
          >
            <span className="text-sm font-medium">
              {m === "connect" ? t.finance.modes.connectTitle : t.finance.modes.importTitle}
            </span>
            <span className="text-[13px] text-muted">
              {m === "connect" ? t.finance.modes.connectBody : t.finance.modes.importBody}
            </span>
          </button>
        ))}
      </div>

      <section className="flex flex-col gap-4">
        {ready.length > 1 && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="sheet-account">{w.googleAccount}</Label>
            <Select
              id="sheet-account"
              value={connectionId}
              onChange={(e) => {
                setConnectionId(e.target.value);
                setSheet(null);
                setTab(null);
                setRecent(null);
              }}
            >
              {ready.map((a) => (
                <option key={a.connectionId} value={a.connectionId}>
                  {a.account ? `${a.name} · ${a.account}` : a.name}
                </option>
              ))}
            </Select>
          </div>
        )}
        <form
          className="flex flex-col gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (link.trim()) open(link);
          }}
        >
          <Label htmlFor="sheet-link">{w.link}</Label>
          <div className="flex gap-2">
            <Input
              id="sheet-link"
              value={link}
              placeholder={w.linkPlaceholder}
              onChange={(e) => setLink(e.target.value)}
            />
            <Button type="submit" variant="secondary" disabled={pending || !link.trim()}>
              {w.open}
            </Button>
          </div>
        </form>
        {recent && recent.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted">{w.recent}</span>
            <ul className="flex flex-col gap-0.5">
              {recent.slice(0, 8).map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => open(r.id)}
                    className={cn(
                      "flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-sm hover:bg-active",
                      sheet?.id === r.id && "bg-active",
                    )}
                  >
                    <FileSpreadsheet className="size-4 shrink-0 text-muted" aria-hidden />
                    <span className="truncate">{r.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        {sheet && (
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted">
              {sheet.title} · {w.tab}
            </span>
            <div className="flex flex-wrap gap-1.5">
              {sheet.tabs.map((tb) => (
                <button
                  key={tb.sheetId}
                  type="button"
                  disabled={pending}
                  onClick={() => pickTab(tb.sheetId)}
                  className={cn(
                    "h-9 rounded-full px-4 text-[13px] transition-colors",
                    tab?.sheetId === tb.sheetId
                      ? "bg-fg text-bg"
                      : "bg-surface-2 text-muted hover:text-fg",
                  )}
                >
                  {tb.title}
                </button>
              ))}
            </div>
          </div>
        )}
        {pending && (
          <p className="flex items-center gap-2 text-[13.5px] text-muted" aria-live="polite">
            <Loader2 className="size-4 animate-spin" aria-hidden />
            {w.reading}
          </p>
        )}
        {error && (
          <p role="alert" className="text-[13.5px] text-danger-text">
            {error}
          </p>
        )}
      </section>

      {tab && mapping && mode === "connect" && (
        <>
          {tab.alreadyConnected && (
            <p className="text-[13.5px] text-approval-text">
              {w.alreadyConnected(tab.alreadyConnected)}
            </p>
          )}
          {tab.alreadyImported && (
            <p className="text-[13.5px] text-approval-text">{w.alreadyImported}</p>
          )}
          <MappingEditor
            headers={tab.headers}
            sample={tab.sample}
            mapping={mapping}
            fromAI={tab.fromAI}
            onChange={(m) => {
              setMapping(m);
              setPreview(null);
            }}
          />
          {preview && <PreviewPanel preview={preview} />}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="sheet-name">{w.name}</Label>
            <Input
              id="sheet-name"
              value={name}
              maxLength={200}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="secondary" disabled={pending} onClick={() => runPreview(mapping)}>
              {w.preview}
            </Button>
            <Button
              disabled={pending || !preview || preview.valid === 0 || Boolean(tab.alreadyConnected)}
              onClick={() =>
                startTransition(async () => {
                  const r = await connectSheetAction({
                    connectionId,
                    spreadsheetId: tab.spreadsheetId,
                    sheetId: tab.sheetId,
                    name,
                    mapping,
                  });
                  if (!r.ok) return fail(r.error);
                  toast.success(w.connectedDone);
                  router.push("/my-elise/finance/sources");
                })
              }
            >
              {w.connect}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

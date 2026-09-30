"use client";

import { ExternalLink, FileUp, Link2, RefreshCw, Sheet } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import type { ImportSummary } from "@/application/finance-import";
import type { FinanceGoogleAccount, FinanceSourceView } from "@/application/finance-sources";
import { GoogleSheetsIcon } from "@/components/elise/brand-icons";
import { Button, buttonVariants } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useRealtimeRefresh } from "@/hooks/use-realtime-refresh";
import { createClient } from "@/infrastructure/supabase/client";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

import {
  financeToolAction,
  prepareFileImportAction,
  removeSourceAction,
  syncSourceAction,
  updateSourceAction,
} from "./actions";

const DOT: Record<string, string> = {
  ready: "bg-success",
  syncing: "bg-accent animate-pulse",
  idle: "bg-faint",
  needs_attention: "bg-approval",
  disconnected: "bg-danger",
};

function useRelative() {
  const { locale } = useI18n();
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  return (iso: string) => {
    const minutes = Math.round((new Date(iso).getTime() - Date.now()) / 60000);
    if (Math.abs(minutes) < 60) return rtf.format(minutes, "minute");
    const hours = Math.round(minutes / 60);
    if (Math.abs(hours) < 24) return rtf.format(hours, "hour");
    return rtf.format(Math.round(hours / 24), "day");
  };
}

export function SourcesView({
  sources,
  imports,
  googleAccounts,
  workspaceId,
}: {
  sources: FinanceSourceView[];
  imports: ImportSummary[];
  googleAccounts: FinanceGoogleAccount[];
  workspaceId: string;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const relative = useRelative();
  const file = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [pending, startTransition] = useTransition();
  useRealtimeRefresh(workspaceId, ["finance_sources", "imports"]);
  const sheetsReady = googleAccounts.some((a) => a.ready);

  function act(
    fn: () => Promise<{ ok: boolean; error?: { message: string; code: string } }>,
    success?: string,
  ) {
    startTransition(async () => {
      const r = await fn();
      if (!r.ok)
        toast.error(
          r.error?.message || t.errors.codes[r.error!.code as keyof typeof t.errors.codes],
        );
      else {
        if (success) toast.success(success);
        router.refresh();
      }
    });
  }

  async function upload(f: File) {
    setUploading(true);
    try {
      const prepared = await prepareFileImportAction({ name: f.name, size: f.size, type: f.type });
      if (!prepared.ok) {
        toast.error(prepared.error.message || t.errors.codes[prepared.error.code]);
        return;
      }
      const { error } = await createClient()
        .storage.from("finance-imports")
        .uploadToSignedUrl(prepared.value.path, prepared.value.token, f, {
          contentType: f.type || "application/octet-stream",
        });
      if (error) {
        toast.error(t.errors.codes.INTERNAL_ERROR);
        return;
      }
      router.push(`/my-elise/finance/import/${prepared.value.importId}`);
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="flex flex-col gap-10">
      <div className="grid gap-3 md:grid-cols-2">
        <section className="flex flex-col gap-3 rounded-2xl border border-border bg-surface px-5 py-4">
          <span className="grid size-10 place-items-center rounded-xl bg-surface-2">
            <FileUp className="size-[18px] text-muted" aria-hidden />
          </span>
          <div className="flex flex-col gap-1">
            <h2 className="font-medium">{t.finance.modes.importTitle}</h2>
            <p className="text-[13.5px] text-muted">{t.finance.modes.importBody}</p>
          </div>
          <input
            ref={file}
            type="file"
            accept=".csv,.tsv,.txt,.xlsx"
            className="sr-only"
            tabIndex={-1}
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) void upload(f);
            }}
          />
          <div className="mt-auto flex flex-wrap gap-2">
            <Button disabled={uploading} onClick={() => file.current?.click()}>
              {uploading ? t.finance.wizard.uploading : t.finance.importFile}
            </Button>
            <Link
              href="/my-elise/finance/connect?mode=import"
              className={buttonVariants({ variant: "secondary" })}
            >
              {t.finance.importSheet}
            </Link>
          </div>
          <p className="text-[12.5px] text-faint">{t.finance.importFileHint}</p>
        </section>
        <section className="flex flex-col gap-3 rounded-2xl border border-border bg-surface px-5 py-4">
          <span className="grid size-10 place-items-center rounded-xl bg-surface-2">
            <GoogleSheetsIcon size={20} />
          </span>
          <div className="flex flex-col gap-1">
            <h2 className="font-medium">{t.finance.modes.connectTitle}</h2>
            <p className="text-[13.5px] text-muted">{t.finance.modes.connectBody}</p>
          </div>
          <div className="mt-auto flex flex-wrap gap-2">
            <Link
              href="/my-elise/finance/connect?mode=connect"
              className={buttonVariants({ variant: sheetsReady ? "primary" : "secondary" })}
            >
              <Link2 />
              {t.finance.connectSheet}
            </Link>
            {!sheetsReady && (
              <Link href="/connections" className={buttonVariants({ variant: "ghost" })}>
                {t.finance.wizard.enableSheets}
              </Link>
            )}
          </div>
        </section>
      </div>

      <section className="flex flex-col gap-3">
        <h2 className="type-label text-faint">{t.finance.connected}</h2>
        {sources.length === 0 ? (
          <p className="text-[14px] text-muted">{t.finance.noConnected}</p>
        ) : (
          <ul className="divide-y divide-border rounded-2xl border border-border bg-surface">
            {sources.map((s) => (
              <li key={s.id} className="flex flex-col gap-3 px-4 py-4 sm:px-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="flex min-w-0 items-start gap-3">
                    <Sheet className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{s.name}</p>
                      <p className="flex flex-wrap items-center gap-x-2 text-[12.5px] text-muted">
                        <span
                          className={cn("size-1.5 rounded-full", DOT[s.status] ?? "bg-faint")}
                          aria-hidden
                        />
                        {t.finance.sourceStatus[s.status]}
                        <span className="text-faint">
                          · {s.tab}
                          {s.account && ` · ${s.account}`}
                          {` · ${t.finance.rows(s.rows)}`}
                          {s.invalidRows > 0 && ` · ${t.finance.invalidRows(s.invalidRows)}`}
                          {s.lastSyncedAt && ` · ${t.finance.lastSynced(relative(s.lastSyncedAt))}`}
                        </span>
                      </p>
                      {s.lastErrorCode && s.status === "needs_attention" && (
                        <p className="text-[12.5px] text-approval-text">
                          {t.errors.codes[s.lastErrorCode as keyof typeof t.errors.codes] ??
                            s.lastErrorCode}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={pending || s.status === "syncing"}
                      onClick={() => act(() => syncSourceAction(s.id), t.finance.syncStarted)}
                    >
                      <RefreshCw />
                      {t.finance.syncNow}
                    </Button>
                    <a
                      href={s.url}
                      target="_blank"
                      rel="noreferrer"
                      className={buttonVariants({ size: "sm", variant: "ghost" })}
                    >
                      <ExternalLink />
                      {t.finance.openSheet}
                    </a>
                    {s.status === "needs_attention" && (
                      <Link
                        href="/connections"
                        className={buttonVariants({ size: "sm", variant: "ghost" })}
                      >
                        {t.brief.reconnect}
                      </Link>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      className="hover:text-danger-text"
                      disabled={pending}
                      onClick={() => {
                        if (window.confirm(t.finance.disconnectConfirm))
                          act(() => removeSourceAction(s.id));
                      }}
                    >
                      {t.finance.disconnect}
                    </Button>
                  </div>
                </div>
                <label className="flex items-start gap-3 text-[13.5px]">
                  <Switch
                    checked={s.includeInTotals}
                    disabled={pending}
                    aria-label={t.finance.includeInTotals}
                    onCheckedChange={(v) =>
                      act(() => updateSourceAction(s.id, { includeInTotals: v }))
                    }
                  />
                  <span className="flex flex-col">
                    {t.finance.includeInTotals}
                    <span className="text-[12.5px] text-faint">{t.finance.includeHint}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="type-label text-faint">{t.finance.imports}</h2>
        {imports.length === 0 ? (
          <p className="text-[14px] text-muted">{t.finance.noImports}</p>
        ) : (
          <ul className="divide-y divide-border rounded-2xl border border-border bg-surface">
            {imports.map((i) => (
              <li
                key={i.id}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-5"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm">{i.label}</p>
                  <p className="text-[12.5px] text-muted">
                    {t.finance.importStatus[i.status]}
                    <span className="text-faint">
                      {" · "}
                      {relative(i.completedAt ?? i.createdAt)}
                      {i.status === "completed" || i.status === "rolled_back"
                        ? ` · ${t.finance.importCounts(i.imported, i.invalid, i.duplicates)}`
                        : ""}
                    </span>
                  </p>
                </div>
                {i.status === "completed" && i.imported > 0 && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="hover:text-danger-text"
                    disabled={pending}
                    onClick={() => {
                      if (!window.confirm(t.finance.undoConfirm(i.imported, i.label))) return;
                      act(
                        () => financeToolAction("finance.undoImport", { importId: i.id }),
                        t.finance.undone(i.imported),
                      );
                    }}
                  >
                    {t.finance.undoImport}
                  </Button>
                )}
                {i.status === "importing" && (
                  <Link
                    href={`/my-elise/finance/import/${i.id}`}
                    className={buttonVariants({ size: "sm", variant: "ghost" })}
                  >
                    {t.finance.importStatus.importing}
                  </Link>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

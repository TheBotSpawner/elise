"use client";

import Link from "next/link";
import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";

import type { KnowledgeAccount, NotionChoice } from "@/application/knowledge-service";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

import { addSourceAction, browseDriveAction, searchNotionAction } from "./actions";

type Selected = { id: string; kind: "folder" | "file" | "page" | "database"; name: string };

function AccountSelect({
  accounts,
  value,
  onChange,
}: {
  accounts: KnowledgeAccount[];
  value: string;
  onChange: (id: string) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor="knowledge-account">{t.knowledge.picker.account}</Label>
      <Select id="knowledge-account" value={value} onChange={(e) => onChange(e.target.value)}>
        {accounts.map((a) => (
          <option key={a.connectionId} value={a.connectionId}>
            {a.account ? `${a.name} · ${a.account}` : a.name}
          </option>
        ))}
      </Select>
    </div>
  );
}

function Row({
  selected,
  onToggle,
  label,
  action,
  disabled = false,
}: {
  selected: boolean;
  onToggle: () => void;
  label: string;
  action?: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <li className="flex items-center justify-between gap-3 px-3 py-2">
      <label
        className={cn(
          "flex min-w-0 items-center gap-3 text-sm",
          disabled ? "text-muted" : "cursor-pointer",
        )}
      >
        <input
          type="checkbox"
          checked={selected || disabled}
          disabled={disabled}
          onChange={onToggle}
          className="accent-[var(--accent)]"
        />
        <span className="truncate">{label}</span>
      </label>
      {action}
    </li>
  );
}

function Footer({
  selected,
  pending,
  onStart,
  onCancel,
}: {
  selected: number;
  pending: boolean;
  onStart: () => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className="text-[13px] text-muted">{t.knowledge.picker.selected(selected)}</span>
      <div className="flex gap-2">
        <Button variant="ghost" onClick={onCancel} disabled={pending}>
          {t.knowledge.cancel}
        </Button>
        <Button onClick={onStart} disabled={pending || selected === 0}>
          {t.knowledge.picker.start}
        </Button>
      </div>
    </div>
  );
}

/** After adding: one toast, plus what was already there (never added twice, ADR-037). */
function useAdded() {
  const { t } = useI18n();
  return (value: { added: string[]; skipped: number }) => {
    if (value.added.length) toast.success(t.knowledge.syncing);
    if (value.skipped) toast(t.knowledge.picker.skipped(value.skipped));
  };
}

function NoAccounts() {
  const { t } = useI18n();
  return (
    <div className="flex flex-col items-start gap-3 text-[13.5px] text-muted">
      <p>{t.knowledge.picker.noAccounts}</p>
      <Link href="/connections" className="text-accent-text underline">
        {t.knowledge.goToConnections}
      </Link>
    </div>
  );
}

function useSelection() {
  const [selected, setSelected] = useState<Selected[]>([]);
  const toggle = (item: Selected) =>
    setSelected((s) =>
      s.some((x) => x.id === item.id) ? s.filter((x) => x.id !== item.id) : [...s, item],
    );
  return { selected, toggle, has: (id: string) => selected.some((x) => x.id === id) };
}

/** Pick Drive folders or files for a Space. Nothing is indexed beyond what is selected. */
export function DrivePicker({
  spaceId,
  accounts,
  onDone,
}: {
  spaceId: string;
  accounts: KnowledgeAccount[];
  onDone: () => void;
}) {
  const { t } = useI18n();
  const google = accounts.filter((a) => a.provider === "google");
  const [connectionId, setConnectionId] = useState(google[0]?.connectionId ?? "");
  const [trail, setTrail] = useState<{ id: string; name: string }[]>([
    { id: "root", name: t.knowledge.picker.myDrive },
  ]);
  const [listing, setListing] = useState<{
    folders: { id: string; name: string }[];
    files: { id: string; name: string }[];
  } | null>(null);
  const [pending, startTransition] = useTransition();
  const { selected, toggle, has } = useSelection();
  const added = useAdded();
  const account = google.find((a) => a.connectionId === connectionId);
  const folder = trail.at(-1)!;

  useEffect(() => {
    if (!account?.ready) return;
    let live = true;
    void browseDriveAction(connectionId, folder.id).then((r) => {
      if (!live) return;
      if (r.ok) setListing(r.value);
      else toast.error(t.errors.codes[r.error.code]);
    });
    return () => {
      live = false;
    };
  }, [connectionId, folder.id, account?.ready, t]);

  if (!google.length) return <NoAccounts />;

  return (
    <div className="flex flex-col gap-4">
      <AccountSelect
        accounts={google}
        value={connectionId}
        onChange={(id) => {
          setConnectionId(id);
          setListing(null);
          setTrail([{ id: "root", name: t.knowledge.picker.myDrive }]);
        }}
      />
      {!account?.ready ? (
        <Link href="/connections" className="text-[13.5px] text-accent-text underline">
          {t.knowledge.picker.enableDrive}
        </Link>
      ) : (
        <>
          <nav className="flex flex-wrap items-center gap-1 text-[13px] text-muted">
            {trail.map((c, i) => (
              <button
                key={c.id}
                type="button"
                className={cn("hover:text-fg", i === trail.length - 1 && "text-fg")}
                onClick={() => {
                  setListing(null);
                  setTrail(trail.slice(0, i + 1));
                }}
              >
                {i > 0 && " › "}
                {c.name}
              </button>
            ))}
          </nav>
          <ul className="max-h-80 divide-y divide-border overflow-y-auto rounded-xl border border-border">
            {!listing ? (
              <li className="px-3 py-3 text-[13px] text-faint">…</li>
            ) : listing.folders.length + listing.files.length === 0 ? (
              <li className="px-3 py-3 text-[13px] text-faint">{t.knowledge.picker.nothing}</li>
            ) : (
              <>
                {listing.folders.map((f) => (
                  <Row
                    key={f.id}
                    label={`▸ ${f.name}`}
                    selected={has(f.id)}
                    onToggle={() => toggle({ id: f.id, kind: "folder", name: f.name })}
                    action={
                      <button
                        type="button"
                        className="text-[13px] text-accent-text"
                        onClick={() => {
                          setListing(null);
                          setTrail([...trail, { id: f.id, name: f.name }]);
                        }}
                      >
                        {t.knowledge.picker.open}
                      </button>
                    }
                  />
                ))}
                {listing.files.map((f) => (
                  <Row
                    key={f.id}
                    label={f.name}
                    selected={has(f.id)}
                    onToggle={() => toggle({ id: f.id, kind: "file", name: f.name })}
                  />
                ))}
              </>
            )}
          </ul>
        </>
      )}
      <Footer
        selected={selected.length}
        pending={pending}
        onCancel={onDone}
        onStart={() =>
          startTransition(async () => {
            const r = await addSourceAction({
              spaceId,
              connectionId,
              provider: "google",
              selection: selected,
            });
            if (!r.ok) toast.error(t.errors.codes[r.error.code]);
            else {
              added(r.value);
              onDone();
            }
          })
        }
      />
    </div>
  );
}

/**
 * Pick Notion databases (default) or standalone pages, among those shared with ELISE in Notion.
 * Each one becomes one source; a database's rows are never listed (ADR-037).
 */
export function NotionPicker({
  spaceId,
  accounts,
  notionAvailable,
  onDone,
}: {
  spaceId: string;
  accounts: KnowledgeAccount[];
  notionAvailable: boolean;
  onDone: () => void;
}) {
  const { t } = useI18n();
  const notion = accounts.filter((a) => a.provider === "notion");
  const [connectionId, setConnectionId] = useState(notion[0]?.connectionId ?? "");
  const [kind, setKind] = useState<"database" | "page">("database");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<NotionChoice[] | null>(null);
  const [pending, startTransition] = useTransition();
  const { selected, toggle, has } = useSelection();
  const added = useAdded();

  useEffect(() => {
    if (!connectionId) return;
    let live = true;
    const timer = setTimeout(() => {
      void searchNotionAction(connectionId, query, kind, spaceId).then((r) => {
        if (!live) return;
        if (r.ok) setResults(r.value);
        else toast.error(t.errors.codes[r.error.code]);
      });
    }, 300);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [connectionId, query, kind, spaceId, t]);

  if (!notionAvailable)
    return <p className="text-[13.5px] text-muted">{t.knowledge.picker.notionNotConfigured}</p>;
  if (!notion.length) return <NoAccounts />;

  const p = t.knowledge.picker;
  return (
    <div className="flex flex-col gap-4">
      <AccountSelect accounts={notion} value={connectionId} onChange={setConnectionId} />
      <div role="tablist" aria-label={p.titleNotion} className="flex gap-1.5">
        {(["database", "page"] as const).map((k) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={kind === k}
            onClick={() => {
              setKind(k);
              setResults(null);
            }}
            className={cn(
              "h-8 rounded-full border px-3 text-[13px] transition-colors",
              kind === k
                ? "border-accent bg-accent-soft text-accent-text"
                : "border-border-strong text-muted hover:text-fg",
            )}
          >
            {k === "database" ? p.notionDatabases : p.notionPages}
          </button>
        ))}
      </div>
      <Input
        aria-label={kind === "database" ? p.searchDatabases : p.searchPages}
        placeholder={kind === "database" ? p.searchDatabases : p.searchPages}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {kind === "database" && <p className="-mt-2 text-[12.5px] text-faint">{p.databaseHint}</p>}
      <ul className="max-h-80 divide-y divide-border overflow-y-auto rounded-xl border border-border">
        {!results ? (
          <li className="px-3 py-3 text-[13px] text-faint">…</li>
        ) : results.length === 0 ? (
          <li className="px-3 py-3 text-[13px] text-faint">{p.nothing}</li>
        ) : (
          results.map((r) => (
            <Row
              key={r.id}
              label={r.name}
              disabled={r.added}
              selected={has(r.id)}
              onToggle={() => toggle({ id: r.id, kind: r.kind, name: r.name })}
              action={
                r.added ? (
                  <span className="shrink-0 text-[12.5px] text-success">✓ {p.alreadyAdded}</span>
                ) : undefined
              }
            />
          ))
        )}
      </ul>
      {/* Notion only shows ELISE what was shared with it: say so instead of looking empty. */}
      <p className="text-[12.5px] text-muted">
        {p.notionAccess}{" "}
        <Link href="/connections" className="text-accent-text underline">
          {p.reconnectNotion}
        </Link>
      </p>
      <Footer
        selected={selected.length}
        pending={pending}
        onCancel={onDone}
        onStart={() =>
          startTransition(async () => {
            const r = await addSourceAction({
              spaceId,
              connectionId,
              provider: "notion",
              selection: selected,
            });
            if (!r.ok) toast.error(t.errors.codes[r.error.code]);
            else {
              added(r.value);
              onDone();
            }
          })
        }
      />
    </div>
  );
}

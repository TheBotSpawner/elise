"use client";

import { AlertTriangle, Search } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useId, useMemo, useState } from "react";
import { toast } from "sonner";

import type { ErrorCode } from "@/core/errors";
import {
  PROVIDER_CATALOG,
  PROVIDER_CATEGORIES,
  searchCatalog,
  summarize,
  type HubAccount,
  type ProviderCatalogEntry,
  type ProviderSummary,
} from "@/core/providers/catalog";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

import { ProviderIcon } from "./provider-icon";

type Filter = "all" | "connected" | "available";

/**
 * The Connections Hub (ADR-043): providers, never accounts. Search first, a compact strip of
 * what's connected, then the catalog. Everything renders from persisted connection metadata —
 * no provider is called to draw this page. Details open in each provider's own page.
 */
export function ConnectionsHub({
  accounts,
  configured,
}: {
  accounts: HubAccount[];
  /** Providers set up on this server (e.g. Spotify needs its client id). */
  configured: Record<string, boolean>;
}) {
  const { t } = useI18n();
  const h = t.connectionsHub;
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const searchId = useId();
  useConnectionReturn();

  const summaries = useMemo(
    () =>
      new Map(
        PROVIDER_CATALOG.map((e) => [e.id, summarize(e, accounts, configured[e.id] ?? false)]),
      ),
    [accounts, configured],
  );
  const external = PROVIDER_CATALOG.filter((e) => !e.builtIn);
  const native = PROVIDER_CATALOG.find((e) => e.builtIn);
  const connected = external.filter((e) => summaries.get(e.id)!.accounts > 0);

  const results = searchCatalog(
    external,
    query,
    {
      description: (id) => h.descriptions[id] ?? "",
      capability: (key) => t.capabilities[key],
    },
    accounts,
  ).filter((e) => {
    const s = summaries.get(e.id)!;
    return filter === "connected"
      ? s.accounts > 0
      : filter === "available"
        ? s.accounts === 0 && s.status !== "unavailable"
        : true;
  });
  const grouped = !query && filter === "all";

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-3">
        <label htmlFor={searchId} className="sr-only">
          {h.search}
        </label>
        <div className="relative">
          <Search
            className="pointer-events-none absolute top-1/2 left-4 size-4 -translate-y-1/2 text-faint"
            aria-hidden
          />
          <input
            id={searchId}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={h.search}
            aria-describedby={`${searchId}-hint`}
            autoComplete="off"
            className="h-12 w-full rounded-2xl border border-border bg-surface pr-4 pl-11 text-[15px] text-fg placeholder:text-muted/70 hover:border-border-strong focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent-soft focus-visible:outline-none"
          />
          <span id={`${searchId}-hint`} className="sr-only">
            {h.searchHint}
          </span>
        </div>
        <div role="group" aria-label={h.filterLabel} className="flex gap-1.5">
          {(["all", "connected", "available"] as const).map((f) => (
            <button
              key={f}
              type="button"
              aria-pressed={filter === f}
              onClick={() => setFilter(f)}
              className={cn(
                "h-8 rounded-full border px-3 text-[13px] transition-colors",
                filter === f
                  ? "border-accent-line bg-accent-soft text-accent-text"
                  : "border-border text-muted hover:border-border-strong hover:text-fg",
              )}
            >
              {h.filters[f]}
            </button>
          ))}
        </div>
      </div>

      {grouped && connected.length > 0 && (
        <section aria-labelledby="hub-connected" className="flex flex-col gap-2">
          <h2 id="hub-connected" className="type-label text-faint">
            {h.connectedTitle}
          </h2>
          <ul className="-mx-1 flex snap-x gap-2 overflow-x-auto px-1 pb-1 sm:flex-wrap sm:overflow-visible">
            {connected.map((e) => (
              <li key={e.id} className="snap-start">
                <ConnectedChip entry={e} summary={summaries.get(e.id)!} />
              </li>
            ))}
          </ul>
        </section>
      )}

      {grouped ? (
        <section aria-labelledby="hub-all" className="flex flex-col gap-5">
          <h2 id="hub-all" className="type-label text-faint">
            {h.allTitle}
          </h2>
          {PROVIDER_CATEGORIES.filter((c) => c !== "native").map((category) => {
            const items = external.filter((e) => e.category === category);
            if (!items.length) return null;
            return (
              <div key={category} className="flex flex-col gap-2">
                <h3 className="text-[13px] font-medium text-muted">{h.categories[category]}</h3>
                <ProviderGrid entries={items} summaries={summaries} />
              </div>
            );
          })}
        </section>
      ) : results.length ? (
        <section aria-live="polite" className="flex flex-col gap-2">
          <ProviderGrid entries={results} summaries={summaries} />
        </section>
      ) : (
        <p aria-live="polite" className="text-[14px] text-muted">
          {h.noResults(query)}
        </p>
      )}

      {native && grouped && (
        <section
          aria-labelledby="hub-native"
          className="flex flex-col gap-2 border-t border-border pt-6"
        >
          <h2 id="hub-native" className="type-label text-faint">
            {h.categories.native}
          </h2>
          <Link
            href={`/connections/${native.id}`}
            className="flex items-center gap-3 rounded-2xl px-2 py-2 transition-colors hover:bg-active focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
          >
            <ProviderIcon id={native.id} name={native.name} size={36} />
            <span className="min-w-0 flex-1">
              <span className="block text-[14.5px] font-medium">{native.name}</span>
              <span className="block truncate text-[13px] text-muted">
                {native.capabilities.map((c) => t.capabilities[c]).join(" · ")}
              </span>
            </span>
            <span className="text-[12.5px] text-faint">{h.builtIn}</span>
          </Link>
        </section>
      )}
    </div>
  );
}

function ProviderGrid({
  entries,
  summaries,
}: {
  entries: ProviderCatalogEntry[];
  summaries: Map<string, ProviderSummary>;
}) {
  return (
    <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
      {entries.map((e) => (
        <li key={e.id}>
          <ProviderCard entry={e} summary={summaries.get(e.id)!} />
        </li>
      ))}
    </ul>
  );
}

/** "3 cuentas conectadas · Calendar · Gmail", "⚠ 1 necesita atención", "Conectar"… */
function useStatusLine(entry: ProviderCatalogEntry, s: ProviderSummary) {
  const { t } = useI18n();
  const h = t.connectionsHub;
  if (s.status === "unavailable") return { text: h.comingSoon, tone: "faint" as const };
  if (!s.accounts) return { text: h.connect, tone: "accent" as const };
  const count =
    entry.id === "notion"
      ? h.workspaces(s.accounts)
      : entry.multiAccount
        ? h.accounts(s.accounts)
        : h.status.connected;
  if (s.attention)
    return { text: `${count} · ${h.attention(s.attention)}`, tone: "attention" as const };
  return {
    text: [count, ...s.enabled.map((c) => t.capabilities[c])].join(" · "),
    tone: "muted" as const,
  };
}

function ProviderCard({
  entry,
  summary,
}: {
  entry: ProviderCatalogEntry;
  summary: ProviderSummary;
}) {
  const { t } = useI18n();
  const h = t.connectionsHub;
  const line = useStatusLine(entry, summary);
  const planned = summary.status === "unavailable";
  const body = (
    <>
      <ProviderIcon id={entry.id} name={entry.name} />
      <span className="min-w-0 flex-1">
        <span className="block text-[14.5px] font-medium">{entry.name}</span>
        <span className="block truncate text-[13px] text-muted">{h.descriptions[entry.id]}</span>
        <span
          className={cn(
            "mt-0.5 flex items-center gap-1.5 truncate text-[12.5px]",
            line.tone === "attention"
              ? "text-approval-text"
              : line.tone === "accent"
                ? "text-accent-text"
                : line.tone === "faint"
                  ? "text-faint"
                  : "text-faint",
          )}
        >
          {line.tone === "attention" && <AlertTriangle className="size-3.5 shrink-0" aria-hidden />}
          {line.tone === "muted" && (
            <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-success" />
          )}
          <span className="truncate">{line.text}</span>
        </span>
      </span>
    </>
  );
  const frame =
    "flex h-full items-start gap-3 rounded-2xl border bg-surface px-4 py-3.5 transition-colors";
  return planned ? (
    <div aria-disabled className={cn(frame, "border-dashed border-border opacity-70")}>
      {body}
    </div>
  ) : (
    <Link
      href={`/connections/${entry.id}`}
      aria-label={`${entry.name}: ${h.descriptions[entry.id]} ${line.text}`}
      className={cn(
        frame,
        summary.attention ? "border-approval-line" : "border-border",
        "hover:border-accent/50 focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none",
      )}
    >
      {body}
    </Link>
  );
}

function ConnectedChip({
  entry,
  summary,
}: {
  entry: ProviderCatalogEntry;
  summary: ProviderSummary;
}) {
  const { t } = useI18n();
  const h = t.connectionsHub;
  const label = [
    entry.name,
    entry.multiAccount ? h.accounts(summary.accounts) : h.status.connected,
    summary.attention ? h.attention(summary.attention) : null,
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <Link
      href={`/connections/${entry.id}`}
      aria-label={label}
      title={label}
      className="flex h-11 shrink-0 items-center gap-2 rounded-full border border-border bg-surface pr-3.5 pl-1.5 text-[13.5px] transition-colors hover:border-accent/50 focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
    >
      <ProviderIcon id={entry.id} name={entry.name} size={32} />
      <span>{entry.name}</span>
      {summary.attention ? (
        <AlertTriangle className="size-3.5 text-approval-text" aria-hidden />
      ) : entry.multiAccount ? (
        <span className="rounded-full bg-surface-2 px-1.5 font-mono text-[11.5px] text-muted">
          {summary.accounts}
        </span>
      ) : (
        <span aria-hidden className="size-1.5 rounded-full bg-success" />
      )}
    </Link>
  );
}

/**
 * OAuth callbacks land on /connections (an allowlisted return path): say how it went, then open
 * the provider that was just connected, with the new account expanded.
 */
function useConnectionReturn() {
  const { t } = useI18n();
  const params = useSearchParams();
  const router = useRouter();
  useEffect(() => {
    const connected = params.get("connected");
    const provider = params.get("provider") ?? (connected ? "google" : null);
    const missing = params.get("missing");
    const error = params.get("error") as ErrorCode | null;
    if (!connected && !error && !provider) return;
    if (connected)
      toast.success(
        provider === "notion"
          ? t.connections.connectedNotionToast
          : provider === "spotify"
            ? t.connections.connectedSpotifyToast
            : t.connections.connectedToast,
      );
    if (missing) {
      const names = missing
        .split(",")
        .map((c) => t.capabilities[c as keyof typeof t.capabilities] ?? c);
      toast.warning(t.connections.missingToast(names.join(", ")));
    }
    if (error) toast.error(t.errors.codes[error] ?? t.errors.codes.INTERNAL_ERROR);
    router.replace(
      provider && !error
        ? `/connections/${provider}${connected ? `?opened=${connected}` : ""}`
        : "/connections",
    );
  }, [params, router, t]);
}

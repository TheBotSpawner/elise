"use client";

import { AlertTriangle, ChevronLeft } from "lucide-react";
import Link from "next/link";
import { useTransition, type ReactNode } from "react";
import { toast } from "sonner";

import type { ConnectionView } from "@/application/connections-service";
import { Button } from "@/components/ui/button";
import { catalogEntry, summarize, type ProviderCatalogEntry } from "@/core/providers/catalog";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

import {
  ConnectGoogleAction,
  DefaultMark,
  GoogleConnectionCard,
  MusicConnectionCard,
  NotionConnectionCard,
  selectableFor,
} from "./accounts";
import { connectNotion, connectSpotify, enableYouTubeAction, setDefaultAction } from "./actions";
import { ProviderIcon } from "./provider-icon";

/**
 * Provider Detail (ADR-043): one provider and its accounts — each account compact until
 * expanded, where its capabilities, alias, "use this account for", reconnect and disconnect
 * live. Accounts that need the user open by themselves, so the exact account, capability and
 * reason are in view.
 */
export function ProviderDetail({
  providerId,
  connections,
  configured,
  opened = null,
  children,
}: {
  providerId: string;
  /** Every connection of the workspace (defaults are decided across providers). */
  connections: ConnectionView[];
  configured: boolean;
  /** Just connected: shown expanded this once. */
  opened?: string | null;
  /** Provider-specific sections (Notion's mapped databases). */
  children?: ReactNode;
}) {
  const { t } = useI18n();
  const h = t.connectionsHub;
  const entry = catalogEntry(providerId)!;
  const mine = connections.filter((c) => c.providerKey === providerId);
  const summary = summarize(entry, connections, configured);
  const multi = (key: string) => selectableFor(connections, key) > 1;
  const count =
    providerId === "notion"
      ? h.workspaces(mine.length)
      : entry.multiAccount
        ? h.accounts(mine.length)
        : mine.length
          ? h.status.connected
          : h.status.not_connected;

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-4">
        <Link
          href="/connections"
          className="flex w-fit items-center gap-1 text-[13px] text-muted hover:text-fg"
        >
          <ChevronLeft className="size-4" aria-hidden />
          {h.back}
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 items-start gap-4">
            <ProviderIcon id={entry.id} name={entry.name} size={52} />
            <div className="min-w-0">
              <h1 className="text-[26px] leading-tight font-light tracking-[-0.02em]">
                {entry.name}
              </h1>
              <p className="mt-1 max-w-xl text-[14px] text-muted">
                {h.intros[entry.id] ?? h.descriptions[entry.id]}
              </p>
              <p
                className={cn(
                  "mt-2 flex items-center gap-1.5 text-[13px]",
                  summary.attention ? "text-approval-text" : "text-faint",
                )}
              >
                {summary.attention ? <AlertTriangle className="size-3.5" aria-hidden /> : null}
                {entry.builtIn ? h.builtIn : count}
                {summary.attention ? ` · ${h.attention(summary.attention)}` : ""}
              </p>
            </div>
          </div>
          {!entry.builtIn && (
            <ConnectAction entry={entry} accounts={mine.length} configured={configured} />
          )}
        </div>
      </header>

      {entry.builtIn ? (
        <NativeCapabilities connection={mine[0]} multi={multi} />
      ) : (
        mine.length > 0 && (
          <section aria-labelledby="provider-accounts" className="flex flex-col gap-3">
            <h2 id="provider-accounts" className="type-label text-faint">
              {h.accountsTitle}
            </h2>
            {mine.map((c) =>
              providerId === "google" ? (
                <GoogleConnectionCard
                  key={c.id}
                  connection={c}
                  googleAvailable={configured}
                  multi={multi}
                  openOnce={c.id === opened || c.health !== "connected"}
                />
              ) : providerId === "notion" ? (
                <NotionConnectionCard key={c.id} connection={c} notionAvailable={configured} />
              ) : (
                <MusicConnectionCard
                  key={c.id}
                  connection={c}
                  name={entry.name}
                  detail={
                    providerId === "youtube"
                      ? t.connections.youtubeCapabilities
                      : t.connections.musicCapabilities
                  }
                  reconnect={providerId === "spotify" && configured ? connectSpotify : null}
                />
              ),
            )}
          </section>
        )
      )}

      {providerId === "deezer" && (
        <p className="text-[13.5px] text-muted">{t.connections.deezerUnavailable}</p>
      )}
      {children}
    </div>
  );
}

/** Connect (or connect another account): the same canonical connection actions as always. */
function ConnectAction({
  entry,
  accounts,
  configured,
}: {
  entry: ProviderCatalogEntry;
  accounts: number;
  configured: boolean;
}) {
  const { t } = useI18n();
  const h = t.connectionsHub;
  if (entry.availability === "planned")
    return <span className="text-[13px] text-faint">{h.comingSoon}</span>;
  if (!configured) return <span className="text-[13px] text-faint">{h.notConfigured}</span>;
  if (accounts && !entry.multiAccount) return null;
  const label = accounts ? h.connectAnother : h.connect;
  switch (entry.id) {
    case "google":
      return (
        <div className="w-full sm:w-64">
          <ConnectGoogleAction label={label} />
        </div>
      );
    case "notion":
      return (
        <form action={connectNotion}>
          <Button type="submit">{label}</Button>
        </form>
      );
    case "spotify":
      return (
        <form action={connectSpotify}>
          <Button type="submit">{label}</Button>
        </form>
      );
    case "youtube":
      return (
        <form action={enableYouTubeAction}>
          <Button type="submit">{t.connections.enableYouTube}</Button>
        </form>
      );
    default:
      return null;
  }
}

/** ELISE's built-in capabilities: no connect, no disconnect — only which one is the default. */
function NativeCapabilities({
  connection,
  multi,
}: {
  connection: ConnectionView | undefined;
  multi: (key: string) => boolean;
}) {
  const { t } = useI18n();
  const [pending, startTransition] = useTransition();
  if (!connection) return null;
  return (
    <section aria-labelledby="native-caps" className="flex flex-col gap-3">
      <h2 id="native-caps" className="type-label text-faint">
        {t.connectionsHub.capabilitiesTitle}
      </h2>
      <p className="text-[13.5px] text-muted">{t.connections.eliseBody}</p>
      <ul className="flex flex-wrap gap-2">
        {connection.capabilities.map((cap) => (
          <li
            key={cap.key}
            className={cn(
              "flex h-9 items-center gap-1 rounded-full border border-border text-[13.5px]",
              multi(cap.key) ? "pr-0.5 pl-3" : "px-3",
            )}
          >
            {t.capabilities[cap.key]}
            {multi(cap.key) && (
              <DefaultMark
                capability={cap.key}
                isDefault={cap.isDefault}
                disabled={pending}
                onSelect={() =>
                  startTransition(async () => {
                    const r = await setDefaultAction(connection.id, cap.key);
                    if (!r.ok) toast.error(t.errors.codes[r.error.code]);
                  })
                }
              />
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

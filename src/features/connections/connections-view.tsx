"use client";

import { ChevronDown } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, useSyncExternalStore, useTransition } from "react";
import { toast } from "sonner";

import type { ConnectionView } from "@/application/connections-service";
import {
  GmailIcon,
  GoogleCalendarIcon,
  GoogleMark,
  GoogleDriveIcon,
  GoogleTasksIcon,
  NotionIcon,
} from "@/components/elise/brand-icons";
import { CheckIcon } from "@/components/elise/icons";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import type { ErrorCode } from "@/core/errors";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

import {
  connectGoogle,
  disconnectAction,
  renameConnectionAction,
  setDefaultAction,
  connectNotion,
  toggleCapabilityAction,
  type ConnectionActionResult,
} from "./actions";

const GOOGLE_CAPS = ["calendar", "tasks", "email", "knowledge"] as const;
const CAP_LOGOS = {
  calendar: GoogleCalendarIcon,
  tasks: GoogleTasksIcon,
  email: GmailIcon,
  knowledge: GoogleDriveIcon,
} as const;
// Product names are brands: never translated.
const CAP_PRODUCT = {
  calendar: "Google Calendar",
  tasks: "Google Tasks",
  email: "Gmail",
  knowledge: "Google Drive",
} as const;
/** Gmail is opt-in: its consent is broader, so least privilege by default. */
const OPT_IN = new Set<string>(["email", "knowledge"]);

// Which account cards are expanded, remembered per browser (collapsed by default).
const EXPANDED_KEY = "elise.connections.expanded";
const expandedListeners = new Set<() => void>();
function readExpanded(): string {
  try {
    return window.localStorage.getItem(EXPANDED_KEY) ?? "[]";
  } catch {
    return "[]";
  }
}
function subscribeExpanded(callback: () => void) {
  expandedListeners.add(callback);
  window.addEventListener("storage", callback);
  return () => {
    expandedListeners.delete(callback);
    window.removeEventListener("storage", callback);
  };
}
function parseExpanded(raw: string): string[] {
  try {
    const ids = JSON.parse(raw) as unknown;
    return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
function setExpanded(id: string, open: boolean) {
  const ids = parseExpanded(readExpanded()).filter((x) => x !== id);
  try {
    window.localStorage.setItem(EXPANDED_KEY, JSON.stringify(open ? [...ids, id] : ids));
  } catch {
    // Private mode: the card still toggles for this visit via the listeners below.
  }
  expandedListeners.forEach((l) => l());
}
function useExpanded(id: string): [boolean, (open: boolean) => void] {
  const raw = useSyncExternalStore(subscribeExpanded, readExpanded, () => "[]");
  return [parseExpanded(raw).includes(id), (open) => setExpanded(id, open)];
}

export function ConnectionsView({
  connections,
  googleAvailable,
  notionAvailable,
}: {
  connections: ConnectionView[];
  googleAvailable: boolean;
  notionAvailable: boolean;
}) {
  const { t } = useI18n();
  const params = useSearchParams();
  const router = useRouter();

  // One-shot feedback after returning from Google, then clean the URL.
  useEffect(() => {
    const connected = params.get("connected");
    const missing = params.get("missing");
    const error = params.get("error") as ErrorCode | null;
    if (!connected && !error) return;
    if (connected) {
      toast.success(t.connections.connectedToast);
      // The account just connected opens so its settings are at hand.
      setExpanded(connected, true);
    }
    if (missing) {
      const names = missing
        .split(",")
        .map((c) => t.capabilities[c as keyof typeof t.capabilities] ?? c);
      toast.warning(t.connections.missingToast(names.join(", ")));
    }
    if (error) toast.error(t.errors.codes[error] ?? t.errors.codes.INTERNAL_ERROR);
    router.replace("/connections");
  }, [params, router, t]);

  const elise = connections.filter((c) => c.providerKey === "elise_native");
  const google = connections.filter((c) => c.providerKey === "google");
  const notion = connections.filter((c) => c.providerKey === "notion");

  return (
    <div className="flex flex-col gap-10">
      <section className="flex flex-col gap-3">
        <h2 className="type-label text-faint">ELISE</h2>
        {elise.map((c) => (
          <div
            key={c.id}
            className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border bg-surface px-5 py-4"
          >
            <div>
              <p className="font-medium">ELISE</p>
              <p className="text-[13.5px] text-muted">{t.connections.eliseBody}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              {c.capabilities.map((cap) => (
                <span
                  key={cap.key}
                  className="flex h-8 items-center gap-2 rounded-full border border-border px-3 text-[13px]"
                >
                  {t.capabilities[cap.key]}
                  {cap.isDefault && (
                    <span className="type-label text-accent-text">{t.connections.default}</span>
                  )}
                </span>
              ))}
            </div>
          </div>
        ))}
      </section>

      <section className="flex flex-col gap-3">
        <div>
          <h2 className="type-label text-faint">{t.connections.googleTitle}</h2>
          <p className="mt-1 max-w-2xl text-[13.5px] text-muted">{t.connections.googleBody}</p>
        </div>
        {google.map((c) => (
          <GoogleConnectionCard key={c.id} connection={c} googleAvailable={googleAvailable} />
        ))}
        {googleAvailable ? (
          <ConnectGooglePanel
            title={google.length ? t.connections.addGoogle : t.connections.connectGoogle}
          />
        ) : (
          <p className="rounded-2xl border border-dashed border-border px-5 py-4 text-[13.5px] text-muted">
            {t.connections.notConfigured}
          </p>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <div>
          <h2 className="type-label text-faint">Notion</h2>
          <p className="mt-1 max-w-2xl text-[13.5px] text-muted">{t.connections.notionBody}</p>
        </div>
        {notion.map((c) => (
          <NotionConnectionCard key={c.id} connection={c} notionAvailable={notionAvailable} />
        ))}
        {notionAvailable ? (
          <form
            action={connectNotion}
            className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border bg-surface p-5"
          >
            <span className="flex items-center gap-3">
              <NotionIcon size={32} />
              <span className="text-[13.5px] text-muted">{t.connections.notionHint}</span>
            </span>
            <Button type="submit">
              {notion.length ? t.connections.addNotion : t.connections.connectNotion}
            </Button>
          </form>
        ) : (
          <p className="rounded-2xl border border-dashed border-border px-5 py-4 text-[13.5px] text-muted">
            {t.connections.notionNotConfigured}
          </p>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="type-label text-faint">{t.connections.comingSoon}</h2>
        <div className="flex flex-wrap gap-2">
          {(["web_search"] as const).map((p) => (
            <span
              key={p}
              className="flex h-9 items-center rounded-full border border-dashed border-border px-4 text-[13px] text-muted"
            >
              {t.providers[p]}
            </span>
          ))}
        </div>
      </section>
    </div>
  );
}

function ConnectGooglePanel({ title }: { title: string }) {
  const { t } = useI18n();
  return (
    <form
      action={connectGoogle}
      className="flex flex-col gap-5 rounded-2xl border border-border bg-surface p-5"
    >
      <div className="flex items-start gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-full border border-border bg-bg">
          <GoogleMark size={20} />
        </span>
        <div>
          <p className="font-medium">{title}</p>
          <p className="text-[13.5px] text-muted">{t.connections.choose}</p>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {GOOGLE_CAPS.map((cap) => {
          const Logo = CAP_LOGOS[cap];
          return (
            <label
              key={cap}
              className="group relative flex cursor-pointer items-start gap-3.5 rounded-xl border border-border-strong bg-bg p-4 transition-colors duration-[var(--dur-xs)] hover:border-fg/30 has-[:checked]:border-accent has-[:checked]:bg-accent-soft has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent"
            >
              <input
                type="checkbox"
                name="capability"
                value={cap}
                defaultChecked={!OPT_IN.has(cap)}
                className="peer sr-only"
              />
              <Logo size={36} className="shrink-0" />
              <span className="min-w-0 pr-6">
                <span className="block text-sm font-medium">{CAP_PRODUCT[cap]}</span>
                <span className="block text-[13px] text-muted">
                  {t.connections.capabilityBody[cap]}
                </span>
              </span>
              <span
                aria-hidden
                className="absolute top-3.5 right-3.5 grid size-5 place-items-center rounded-full border border-border-strong text-accent-fg transition-colors peer-checked:border-accent peer-checked:bg-accent [&>svg]:opacity-0 peer-checked:[&>svg]:opacity-100"
              >
                <CheckIcon size={12} strokeWidth={2.4} />
              </span>
            </label>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[13px] text-faint">{t.connections.chooseHint}</p>
        <Button type="submit">
          <GoogleMark size={16} />
          {t.connections.continueWithGoogle}
        </Button>
      </div>
    </form>
  );
}

function GoogleConnectionCard({
  connection: c,
  googleAvailable,
}: {
  connection: ConnectionView;
  googleAvailable: boolean;
}) {
  const { t } = useI18n();
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState(c.displayName);
  const [context, setContext] = useState(c.contextLabel ?? "");
  const [expanded, setOpen] = useExpanded(c.id);
  const healthy = c.status === "connected";
  const enabled = GOOGLE_CAPS.filter((key) =>
    c.capabilities.some((x) => x.key === key && x.enabled),
  )
    .map((key) => CAP_PRODUCT[key])
    .join(" · ");
  const dirty = name !== c.displayName || context !== (c.contextLabel ?? "");

  function act(fn: () => Promise<ConnectionActionResult>, success?: string) {
    startTransition(async () => {
      const result = await fn();
      if (!result.ok) toast.error(t.errors.codes[result.error.code]);
      else if (success) toast.success(success);
    });
  }

  return (
    <article
      aria-label={`${c.displayName} · ${c.accountLabel ?? ""}`}
      className={cn(
        "flex flex-col gap-4 rounded-2xl border bg-surface px-5 py-4",
        healthy ? "border-border" : "border-approval-line bg-approval-bg",
      )}
    >
      <header>
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={`conn-${c.id}`}
          aria-label={
            expanded ? t.connections.collapse(c.displayName) : t.connections.expand(c.displayName)
          }
          onClick={() => setOpen(!expanded)}
          className="-mx-2 -my-1 grid w-[calc(100%+1rem)] grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-xl px-2 py-1 text-left transition-colors hover:bg-active"
        >
          <span className="grid size-9 place-items-center rounded-full border border-border bg-bg">
            <GoogleMark size={18} />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-base font-medium">{c.displayName}</span>
            <span className="block truncate text-[13px] text-muted">{c.accountLabel}</span>
            {enabled && <span className="block truncate text-[12.5px] text-faint">{enabled}</span>}
          </span>
          <span className="flex items-center gap-2">
            {healthy ? (
              <span className="hidden items-center gap-2 text-[13px] text-muted sm:flex">
                <span aria-hidden className="size-1.5 rounded-full bg-success" />
                {t.connections.connected}
              </span>
            ) : (
              <span className="flex items-center gap-2 text-[13px] text-approval-text">
                <span aria-hidden className="size-1.5 rounded-full bg-approval" />
                {t.connections.needsAttention}
              </span>
            )}
            <ChevronDown
              className={cn("size-4 text-faint transition-transform", expanded && "rotate-180")}
              aria-hidden
            />
          </span>
        </button>
      </header>

      {expanded && (
        <div id={`conn-${c.id}`} className="flex flex-col gap-4">
          {!healthy && (
            <form
              action={connectGoogle}
              className="flex flex-wrap items-center justify-between gap-3"
            >
              <p className="text-[13.5px] text-approval-text">{t.connections.needsAttentionBody}</p>
              <input type="hidden" name="connectionId" value={c.id} />
              {c.capabilities.map((cap) => (
                <input key={cap.key} type="hidden" name="capability" value={cap.key} />
              ))}
              {googleAvailable && <Button type="submit">{t.connections.reconnect}</Button>}
            </form>
          )}

          <ul className="flex flex-col divide-y divide-border rounded-xl border border-border">
            {GOOGLE_CAPS.map((key) => {
              const cap = c.capabilities.find((x) => x.key === key);
              const granted = Boolean(cap?.granted);
              const Logo = CAP_LOGOS[key];
              return (
                <li
                  key={key}
                  className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5"
                >
                  <span className="flex items-center gap-3 text-sm">
                    <Logo size={24} className={cn(!cap?.enabled && "opacity-50 grayscale")} />
                    {CAP_PRODUCT[key]}
                  </span>
                  <div className="flex items-center gap-2">
                    {!granted ? (
                      <form action={connectGoogle}>
                        <input type="hidden" name="connectionId" value={c.id} />
                        <input type="hidden" name="capability" value={key} />
                        <span className="mr-2 text-[13px] text-muted">
                          {t.connections.notAllowed}
                        </span>
                        <Button
                          type="submit"
                          size="sm"
                          variant="secondary"
                          disabled={!googleAvailable}
                        >
                          {t.connections.allow}
                        </Button>
                      </form>
                    ) : (
                      <>
                        {cap?.isDefault ? (
                          <span className="px-2 type-label text-accent-text">
                            {t.connections.default}
                          </span>
                        ) : (
                          cap?.enabled && (
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={pending || !healthy}
                              onClick={() => act(() => setDefaultAction(c.id, key))}
                            >
                              {t.connections.makeDefault}
                            </Button>
                          )
                        )}
                        <Switch
                          checked={Boolean(cap?.enabled)}
                          aria-label={t.capabilities[key]}
                          disabled={pending}
                          onCheckedChange={(on) => act(() => toggleCapabilityAction(c.id, key, on))}
                        />
                      </>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              act(() => renameConnectionAction(c.id, name, context), t.connections.saved);
            }}
            className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-start"
          >
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`name-${c.id}`}>{t.connections.name}</Label>
              <Input
                id={`name-${c.id}`}
                value={name}
                maxLength={120}
                required
                placeholder={t.connections.namePlaceholder}
                aria-describedby={`name-hint-${c.id}`}
                onChange={(e) => setName(e.target.value)}
              />
              <p id={`name-hint-${c.id}`} className="text-[12.5px] text-faint">
                {t.connections.nameHint}
              </p>
            </div>
            <details className="group flex flex-col gap-1.5" open={Boolean(c.contextLabel)}>
              <summary className="flex h-6 cursor-pointer list-none items-center gap-1.5 text-xs font-medium text-muted hover:text-fg [&::-webkit-details-marker]:hidden">
                <ChevronDown
                  className="size-3.5 transition-transform group-open:rotate-180"
                  aria-hidden
                />
                {t.connections.contextSection}
              </summary>
              <div className="mt-1.5 flex flex-col gap-1.5">
                <Label htmlFor={`ctx-${c.id}`}>{t.connections.context}</Label>
                <Input
                  id={`ctx-${c.id}`}
                  value={context}
                  maxLength={80}
                  placeholder={t.connections.contextPlaceholder}
                  aria-describedby={`ctx-hint-${c.id}`}
                  onChange={(e) => setContext(e.target.value)}
                />
                <p id={`ctx-hint-${c.id}`} className="text-[12.5px] text-faint">
                  {t.connections.contextHint}
                </p>
              </div>
            </details>
            <Button
              type="submit"
              variant="secondary"
              disabled={!dirty || pending}
              className="sm:mt-[26px]"
            >
              {t.connections.save}
            </Button>
          </form>

          <div className="flex justify-end">
            <Button
              variant="ghost"
              size="sm"
              disabled={pending}
              className="hover:text-danger-text"
              onClick={() => {
                if (window.confirm(t.connections.disconnectConfirm(c.displayName)))
                  act(() => disconnectAction(c.id));
              }}
            >
              {t.connections.disconnect}
            </Button>
          </div>
        </div>
      )}
    </article>
  );
}

function NotionConnectionCard({
  connection: c,
  notionAvailable,
}: {
  connection: ConnectionView;
  notionAvailable: boolean;
}) {
  const { t } = useI18n();
  const [pending, startTransition] = useTransition();
  const healthy = c.status === "connected";
  return (
    <article
      className={cn(
        "flex flex-wrap items-center justify-between gap-3 rounded-2xl border bg-surface px-5 py-4",
        healthy ? "border-border" : "border-approval-line bg-approval-bg",
      )}
    >
      <div className="flex min-w-0 items-center gap-3">
        <NotionIcon size={28} />
        <div className="min-w-0">
          <p className="truncate font-medium">{c.displayName}</p>
          <p className="truncate text-[13.5px] text-muted">
            {healthy ? t.connections.connected : t.connections.needsAttention}
            {c.accountLabel && ` · ${c.accountLabel}`}
          </p>
        </div>
      </div>
      <div className="flex gap-1">
        {!healthy && notionAvailable && (
          <form action={connectNotion}>
            <Button type="submit" size="sm">
              {t.connections.reconnectNotion}
            </Button>
          </form>
        )}
        <Button
          variant="ghost"
          size="sm"
          disabled={pending}
          className="hover:text-danger-text"
          onClick={() => {
            if (window.confirm(t.connections.disconnectNotionConfirm(c.displayName)))
              startTransition(async () => {
                const result = await disconnectAction(c.id);
                if (!result.ok) toast.error(t.errors.codes[result.error.code]);
              });
          }}
        >
          {t.connections.disconnect}
        </Button>
      </div>
    </article>
  );
}

"use client";

import { ChevronDown, Plus, Star } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, useSyncExternalStore, useTransition } from "react";
import { toast } from "sonner";

import type { ConnectionView } from "@/application/connections-service";
import {
  GmailIcon,
  GoogleCalendarIcon,
  GoogleMark,
  GoogleDriveIcon,
  GoogleSheetsIcon,
  GoogleTasksIcon,
  NotionIcon,
} from "@/components/elise/brand-icons";
import { CheckIcon } from "@/components/elise/icons";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
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

const GOOGLE_CAPS = ["calendar", "tasks", "email", "knowledge", "finance"] as const;
const CAP_LOGOS = {
  calendar: GoogleCalendarIcon,
  tasks: GoogleTasksIcon,
  email: GmailIcon,
  knowledge: GoogleDriveIcon,
  finance: GoogleSheetsIcon,
} as const;
// Product names are brands: never translated.
const CAP_PRODUCT = {
  calendar: "Google Calendar",
  tasks: "Google Tasks",
  email: "Gmail",
  knowledge: "Google Drive",
  finance: "Google Sheets",
} as const;
/** Gmail is opt-in: its consent is broader, so least privilege by default. */
const OPT_IN = new Set<string>(["email", "knowledge", "finance"]);

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
/** `openOnce`: shown expanded in this view only (just connected), not remembered. */
function useExpanded(id: string, openOnce = false): [boolean, (open: boolean) => void] {
  const raw = useSyncExternalStore(subscribeExpanded, readExpanded, () => "[]");
  const [override, setOverride] = useState<boolean | null>(openOnce ? true : null);
  return [
    override ?? parseExpanded(raw).includes(id),
    (open) => {
      setOverride(null);
      setExpanded(id, open);
    },
  ];
}

/**
 * Connections that could receive new items for a capability. Connected sheets are read-only
 * for Finance, so they never compete for its default.
 */
function selectableFor(connections: ConnectionView[], key: string) {
  return connections.filter(
    (c) =>
      c.status === "connected" &&
      !(key === "finance" && c.providerKey !== "elise_native") &&
      c.capabilities.some((x) => x.key === key && x.enabled && x.granted),
  ).length;
}

/**
 * The default provider for a capability, as a compact star. Only rendered when the user has
 * more than one provider for it: with a single one the default is implicit.
 */
function DefaultMark({
  capability,
  isDefault,
  disabled,
  onSelect,
}: {
  capability: ConnectionView["capabilities"][number]["key"];
  isDefault: boolean;
  disabled?: boolean;
  onSelect: () => void;
}) {
  const { t } = useI18n();
  const label = (isDefault ? t.connections.defaultFor : t.connections.makeDefaultFor)(
    t.capabilities[capability],
  );
  return (
    <button
      type="button"
      aria-pressed={isDefault}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={isDefault ? undefined : onSelect}
      className={cn(
        "grid size-7 shrink-0 place-items-center rounded-full transition-colors",
        isDefault ? "cursor-default text-accent" : "text-faint hover:text-fg disabled:opacity-50",
      )}
    >
      <Star className="size-4" fill={isDefault ? "currentColor" : "none"} aria-hidden />
    </button>
  );
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
  const [pending, startTransition] = useTransition();
  // Read once on first render: the URL is cleaned right after.
  const [justConnected] = useState(() => params.get("connected"));
  const multi = (key: string) => selectableFor(connections, key) > 1;
  const makeDefault = (connectionId: string, key: ConnectionView["capabilities"][number]["key"]) =>
    startTransition(async () => {
      const result = await setDefaultAction(connectionId, key);
      if (!result.ok) toast.error(t.errors.codes[result.error.code]);
    });

  // One-shot feedback after returning from Google, then clean the URL.
  useEffect(() => {
    const connected = params.get("connected");
    const missing = params.get("missing");
    const error = params.get("error") as ErrorCode | null;
    if (!connected && !error) return;
    if (connected) {
      toast.success(
        params.get("provider") === "notion"
          ? t.connections.connectedNotionToast
          : t.connections.connectedToast,
      );
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
      {!google.length && !notion.length && (
        <p className="rounded-2xl border border-accent-line bg-accent-soft px-5 py-4 text-[14px]">
          {t.connections.emptyIntro}
        </p>
      )}
      <section className="flex flex-col gap-3">
        <h2 className="type-label text-faint">ELISE</h2>
        {elise.map((c) => (
          <div
            key={c.id}
            className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border bg-surface px-5 py-4"
          >
            <div>
              <p className="flex items-center gap-2 font-medium">
                <span
                  aria-hidden
                  className="size-2.5 rounded-full bg-accent shadow-[0_0_8px_var(--accent)]"
                />
                ELISE
              </p>
              <p className="text-[13.5px] text-muted">{t.connections.eliseBody}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              {c.capabilities.map((cap) => (
                <span
                  key={cap.key}
                  className={cn(
                    "flex h-8 items-center gap-1 rounded-full border border-border text-[13px]",
                    multi(cap.key) ? "pr-0.5 pl-3" : "px-3",
                  )}
                >
                  {t.capabilities[cap.key]}
                  {multi(cap.key) && (
                    <DefaultMark
                      capability={cap.key}
                      isDefault={cap.isDefault}
                      disabled={pending}
                      onSelect={() => makeDefault(c.id, cap.key)}
                    />
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
          <GoogleConnectionCard
            key={c.id}
            connection={c}
            googleAvailable={googleAvailable}
            multi={multi}
            openOnce={c.id === justConnected}
          />
        ))}
        {googleAvailable ? (
          <ConnectGoogleAction
            label={google.length ? t.connections.addGoogle : t.connections.connectGoogle}
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
    </div>
  );
}

/** A compact action; the capability choice only appears, in a dialog, when asked for. */
function ConnectGoogleAction({ label }: { label: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex h-12 items-center justify-center gap-2 rounded-2xl border border-dashed border-border-strong text-[14px] text-muted transition-colors hover:border-accent-line hover:text-fg"
      >
        <Plus className="size-4" aria-hidden />
        {label}
      </button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={t.connections.connectGoogleTitle}
        description={t.connections.choose}
        busy={submitting}
        className="sm:max-w-2xl"
      >
        {/* Children mount only while open: cancelling discards the selection. */}
        <form
          action={connectGoogle}
          onSubmit={() => setSubmitting(true)}
          className="flex flex-col gap-5"
        >
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
          <p className="text-[13px] text-faint">{t.connections.chooseHint}</p>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button
              type="button"
              variant="ghost"
              disabled={submitting}
              onClick={() => setOpen(false)}
            >
              {t.connections.cancel}
            </Button>
            <Button type="submit" disabled={submitting}>
              <GoogleMark size={16} />
              {t.connections.continueWithGoogle}
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}

function GoogleConnectionCard({
  connection: c,
  googleAvailable,
  multi,
  openOnce,
}: {
  connection: ConnectionView;
  googleAvailable: boolean;
  /** Just connected: open in this view, collapsed again on the next visit. */
  openOnce: boolean;
  /** Whether a capability has several providers (only then is the default shown). */
  multi: (key: string) => boolean;
}) {
  const { t } = useI18n();
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState(c.displayName);
  const [context, setContext] = useState(c.contextLabel ?? "");
  const [expanded, setOpen] = useExpanded(c.id, openOnce);
  const healthy = c.health === "connected";
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
            <HealthPill health={c.health} />
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
              <p className="text-[13.5px] text-approval-text">
                {t.connections.healthBody[c.health]}
              </p>
              <input type="hidden" name="connectionId" value={c.id} />
              {/* Missing permission: ask only for that. Lost access: ask again for everything. */}
              {c.capabilities
                .filter((cap) => c.health !== "permission_missing" || (cap.enabled && !cap.granted))
                .map((cap) => (
                  <input key={cap.key} type="hidden" name="capability" value={cap.key} />
                ))}
              {googleAvailable && c.health !== "unavailable" && (
                <Button type="submit">
                  {c.health === "permission_missing"
                    ? t.connections.grantMissing
                    : t.connections.reconnect}
                </Button>
              )}
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
                  <span className="flex min-w-0 items-center gap-3 text-sm">
                    <Logo
                      size={24}
                      className={cn("shrink-0", !cap?.enabled && "opacity-50 grayscale")}
                    />
                    <span className="min-w-0">
                      <span className="block">{CAP_PRODUCT[key]}</span>
                      {/* What ELISE can do with it, in plain words (never scope strings). */}
                      <span className="block text-[12.5px] text-faint">
                        {t.connections.capabilityBody[key]}
                      </span>
                    </span>
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
                        {cap?.enabled && healthy && multi(key) && !(key === "finance") && (
                          <DefaultMark
                            capability={key}
                            isDefault={cap.isDefault}
                            disabled={pending}
                            onSelect={() => act(() => setDefaultAction(c.id, key))}
                          />
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
            <div className="flex flex-col gap-1.5">
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
            <div className="flex flex-col gap-1.5">
              {/* Same height as the field labels, so the button lines up with the inputs. */}
              <Label aria-hidden className="invisible hidden sm:block">
                {t.connections.save}
              </Label>
              <Button type="submit" variant="secondary" disabled={!dirty || pending}>
                {t.connections.save}
              </Button>
            </div>
          </form>

          <div className="flex justify-end">
            <DisconnectButton connection={c} />
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
  const healthy = c.health === "connected";
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
          <p className="truncate text-[13.5px] text-muted">{c.accountLabel}</p>
          <p className="text-[12.5px] text-faint">
            {healthy ? t.connections.notionPermissions : t.connections.healthBody[c.health]}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-1">
        <HealthPill health={c.health} />
        {!healthy && notionAvailable && (
          <form action={connectNotion}>
            <Button type="submit" size="sm">
              {t.connections.reconnectNotion}
            </Button>
          </form>
        )}
        <DisconnectButton connection={c} />
      </div>
    </article>
  );
}

function HealthPill({ health }: { health: ConnectionView["health"] }) {
  const { t } = useI18n();
  const ok = health === "connected";
  return (
    <span
      className={cn(
        "flex items-center gap-2 text-[13px]",
        ok ? "hidden text-muted sm:flex" : "text-approval-text",
      )}
    >
      <span
        aria-hidden
        className={cn("size-1.5 rounded-full", ok ? "bg-success" : "bg-approval")}
      />
      {t.connections.health[health]}
    </span>
  );
}

/** Disconnect explains what happens first: what stops, what is removed, what stays. */
function DisconnectButton({ connection: c }: { connection: ConnectionView }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const consequences =
    c.providerKey === "notion"
      ? t.connections.disconnectNotionConsequences
      : t.connections.disconnectGoogleConsequences;
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="hover:text-danger-text"
        onClick={() => setOpen(true)}
      >
        {t.connections.disconnect}
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={t.connections.disconnectTitle(c.displayName)}
        busy={pending}
      >
        <ul className="flex list-disc flex-col gap-1.5 pl-5 text-[14px] text-muted">
          {consequences.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="ghost" disabled={pending} onClick={() => setOpen(false)}>
            {t.connections.cancel}
          </Button>
          <Button
            variant="danger"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const result = await disconnectAction(c.id);
                if (!result.ok) toast.error(t.errors.codes[result.error.code]);
                else {
                  toast.success(t.connections.disconnected(c.displayName));
                  setOpen(false);
                }
              })
            }
          >
            {pending ? t.connections.disconnecting : t.connections.disconnect}
          </Button>
        </div>
      </Dialog>
    </>
  );
}

"use client";

import { ChevronDown, Plus } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import type { ConnectionView } from "@/application/connections-service";
import { SlackIcon } from "@/components/elise/brand-icons";
import { CheckIcon } from "@/components/elise/icons";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

import { DefaultMark, DisconnectButton, HealthPill, useExpanded } from "./accounts";
import {
  connectSlack,
  renameConnectionAction,
  setDefaultAction,
  toggleCapabilityAction,
  type ConnectionActionResult,
} from "./actions";

/**
 * Slack in Connections (ADR-062): each workspace is its own account card — its icon, name, the
 * Slack user who connected, health, alias, "use this workspace for" and what ELISE may do there.
 * A permission shows as allowed only when Slack granted its scopes; allowing one more runs Slack's
 * consent again for that same workspace (Slack adds it to the same grant).
 */

const PERMISSIONS = ["public", "private", "direct", "files", "send", "reactions"] as const;
type Permission = (typeof PERMISSIONS)[number];
/** Private channels and DMs reach the most personal conversations: chosen, never assumed. */
const OPT_IN = new Set<Permission>(["private", "direct"]);

export function ConnectSlackAction({ label }: { label: string }) {
  const { t } = useI18n();
  const s = t.connections.slack;
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus />
        {label}
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={s.connectTitle}
        description={s.choose}
        busy={submitting}
        className="sm:max-w-2xl"
      >
        <form
          action={connectSlack}
          onSubmit={() => setSubmitting(true)}
          className="flex flex-col gap-5"
        >
          <div className="grid gap-3 sm:grid-cols-2">
            {PERMISSIONS.map((key) => (
              <label
                key={key}
                className={cn(
                  "group relative flex items-start gap-3.5 rounded-xl border border-border-strong bg-bg p-4 transition-colors has-[:checked]:border-accent has-[:checked]:bg-accent-soft has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent",
                  key === "public" ? "cursor-default" : "cursor-pointer hover:border-fg/30",
                )}
              >
                <input
                  type="checkbox"
                  name="permission"
                  value={key}
                  defaultChecked={!OPT_IN.has(key)}
                  // Public channels are the base of every Slack connection.
                  disabled={key === "public"}
                  className="peer sr-only"
                />
                <span className="min-w-0 pr-6">
                  <span className="block text-sm font-medium">{s.permissions[key].name}</span>
                  <span className="block text-[13px] text-muted">{s.permissions[key].body}</span>
                </span>
                <span
                  aria-hidden
                  className="absolute top-3.5 right-3.5 grid size-5 place-items-center rounded-full border border-border-strong text-accent-fg transition-colors peer-checked:border-accent peer-checked:bg-accent [&>svg]:opacity-0 peer-checked:[&>svg]:opacity-100"
                >
                  <CheckIcon size={12} strokeWidth={2.4} />
                </span>
              </label>
            ))}
          </div>
          <p className="text-[13px] text-faint">{s.consent}</p>
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
              <SlackIcon size={16} />
              {s.continue}
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}

function WorkspaceIcon({ src }: { src: string | null }) {
  return src ? (
    // A Slack-hosted https icon; plain <img> keeps it out of the image optimizer.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt=""
      width={36}
      height={36}
      className="size-9 rounded-lg border border-border"
    />
  ) : (
    <span className="grid size-9 place-items-center rounded-lg border border-border bg-bg">
      <SlackIcon size={18} />
    </span>
  );
}

export function SlackConnectionCard({
  connection: c,
  available,
  multi,
  openOnce,
}: {
  connection: ConnectionView;
  available: boolean;
  multi: boolean;
  openOnce: boolean;
}) {
  const { t } = useI18n();
  const s = t.connections.slack;
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState(c.displayName);
  const [context, setContext] = useState(c.contextLabel ?? "");
  const [expanded, setOpen] = useExpanded(c.id, openOnce);
  const healthy = c.health === "connected";
  const cap = c.capabilities.find((x) => x.key === "team_messaging");
  const granted = new Set(c.slack?.permissions.filter((p) => p.granted).map((p) => p.key) ?? []);
  const enabledNames = PERMISSIONS.filter((k) => granted.has(k))
    .map((k) => s.permissions[k].name)
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
      aria-label={`${c.displayName} · ${c.slack?.team ?? ""}`}
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
          <WorkspaceIcon src={c.slack?.icon ?? null} />
          <span className="min-w-0">
            <span className="block truncate text-base font-medium">{c.displayName}</span>
            <span className="block truncate text-[13px] text-muted">
              {c.slack?.team ?? ""}
              {c.slack?.user ? ` · ${s.connectedAs(c.slack.user)}` : ""}
            </span>
            {enabledNames && (
              <span className="block truncate text-[12.5px] text-faint">{enabledNames}</span>
            )}
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
              action={connectSlack}
              className="flex flex-wrap items-center justify-between gap-3"
            >
              <p className="text-[13.5px] text-approval-text">
                {t.connections.healthBody[c.health]}
              </p>
              <input type="hidden" name="connectionId" value={c.id} />
              {available && c.health !== "unavailable" && (
                <Button type="submit">{s.reconnect}</Button>
              )}
            </form>
          )}

          <ul className="flex flex-col divide-y divide-border rounded-xl border border-border">
            <li className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5">
              <span className="flex min-w-0 items-center gap-3 text-sm">
                <SlackIcon
                  size={22}
                  className={cn("shrink-0", !cap?.enabled && "opacity-50 grayscale")}
                />
                <span>{t.capabilities.team_messaging}</span>
              </span>
              <span className="flex items-center gap-2">
                {cap?.enabled && healthy && multi && (
                  <DefaultMark
                    capability="team_messaging"
                    isDefault={cap.isDefault}
                    disabled={pending}
                    onSelect={() => act(() => setDefaultAction(c.id, "team_messaging"))}
                  />
                )}
                <Switch
                  checked={Boolean(cap?.enabled)}
                  aria-label={t.capabilities.team_messaging}
                  disabled={pending || !cap?.granted}
                  onCheckedChange={(on) =>
                    act(() => toggleCapabilityAction(c.id, "team_messaging", on))
                  }
                />
              </span>
            </li>
            {PERMISSIONS.map((key) => (
              <li
                key={key}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5"
              >
                <span className="min-w-0 text-sm">
                  <span className="block">{s.permissions[key].name}</span>
                  <span className="block text-[12.5px] text-faint">{s.permissions[key].body}</span>
                </span>
                {granted.has(key) ? (
                  <span className="flex items-center gap-1.5 text-[13px] text-muted">
                    <CheckIcon size={14} aria-hidden />
                    {s.allowed}
                  </span>
                ) : (
                  // Progressive consent: Slack adds this to the same workspace grant.
                  <form action={connectSlack} className="flex items-center gap-2">
                    <input type="hidden" name="connectionId" value={c.id} />
                    <input type="hidden" name="permission" value={key} />
                    <span className="text-[13px] text-muted">{t.connections.notAllowed}</span>
                    <Button type="submit" size="sm" variant="secondary" disabled={!available}>
                      {t.connections.allow}
                    </Button>
                  </form>
                )}
              </li>
            ))}
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
                onChange={(e) => setName(e.target.value)}
              />
              <p className="text-[12.5px] text-faint">{t.connections.nameHint}</p>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`ctx-${c.id}`}>{s.useFor}</Label>
              <Input
                id={`ctx-${c.id}`}
                value={context}
                maxLength={80}
                placeholder={t.connections.contextPlaceholder}
                onChange={(e) => setContext(e.target.value)}
              />
              <p className="text-[12.5px] text-faint">{t.connections.contextHint}</p>
            </div>
            <div className="flex flex-col gap-1.5">
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

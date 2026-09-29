"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";

import type { ConnectionView } from "@/application/connections-service";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import type { ErrorCode } from "@/core/errors";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

import {
  connectGoogle,
  disconnectAction,
  renameConnectionAction,
  setDefaultAction,
  toggleCapabilityAction,
  type ConnectionActionResult,
} from "./actions";

const GOOGLE_CAPS = ["calendar", "tasks"] as const;

export function ConnectionsView({
  connections,
  googleAvailable,
}: {
  connections: ConnectionView[];
  googleAvailable: boolean;
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
    if (connected) toast.success(t.connections.connectedToast);
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
        <h2 className="type-label text-faint">{t.connections.comingSoon}</h2>
        <div className="flex flex-wrap gap-2">
          {(["notion", "web_search"] as const).map((p) => (
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
      className="flex flex-col gap-4 rounded-2xl border border-border bg-surface px-5 py-4"
    >
      <p className="text-[13.5px] text-muted">{t.connections.choose}</p>
      <div className="flex flex-wrap gap-2">
        {GOOGLE_CAPS.map((cap) => (
          <label
            key={cap}
            className="flex h-10 cursor-pointer items-center gap-2.5 rounded-full border border-border-strong px-4 text-sm has-[:checked]:border-accent has-[:checked]:bg-accent-soft"
          >
            <input
              type="checkbox"
              name="capability"
              value={cap}
              defaultChecked
              className="accent-[var(--accent)]"
            />
            {t.capabilities[cap]}
          </label>
        ))}
      </div>
      <div>
        <Button type="submit">{title}</Button>
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
  const healthy = c.status === "connected";
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
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-base font-medium">{c.displayName}</p>
          <p className="truncate text-[13.5px] text-muted">{c.accountLabel}</p>
        </div>
        {healthy ? (
          <span className="flex h-8 items-center gap-2 rounded-full px-3 text-[13px] text-muted">
            <span aria-hidden className="size-1.5 rounded-full bg-success" />
            {t.connections.connected}
          </span>
        ) : (
          <span className="flex h-8 items-center gap-2 rounded-full px-3 text-[13px] text-approval-text">
            <span aria-hidden className="size-1.5 rounded-full bg-approval" />
            {t.connections.needsAttention}
          </span>
        )}
      </header>

      {!healthy && (
        <form action={connectGoogle} className="flex flex-wrap items-center justify-between gap-3">
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
          return (
            <li key={key} className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5">
              <span className="text-sm">{t.capabilities[key]}</span>
              <div className="flex items-center gap-2">
                {!granted ? (
                  <form action={connectGoogle}>
                    <input type="hidden" name="connectionId" value={c.id} />
                    <input type="hidden" name="capability" value={key} />
                    <span className="mr-2 text-[13px] text-muted">{t.connections.notAllowed}</span>
                    <Button type="submit" size="sm" variant="secondary" disabled={!googleAvailable}>
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
                    <button
                      type="button"
                      role="switch"
                      aria-checked={Boolean(cap?.enabled)}
                      aria-label={t.capabilities[key]}
                      disabled={pending}
                      onClick={() => act(() => toggleCapabilityAction(c.id, key, !cap?.enabled))}
                      className={cn(
                        "relative h-6 w-10 rounded-full border transition-colors duration-[var(--dur-xs)]",
                        cap?.enabled
                          ? "border-accent bg-accent"
                          : "border-border-strong bg-surface-2",
                      )}
                    >
                      <span
                        className={cn(
                          "absolute top-0.5 size-4.5 rounded-full bg-bg transition-transform duration-[var(--dur-xs)]",
                          cap?.enabled ? "translate-x-[18px]" : "translate-x-0.5",
                        )}
                      />
                    </button>
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
        className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`name-${c.id}`}>{t.connections.name}</Label>
          <Input
            id={`name-${c.id}`}
            value={name}
            maxLength={120}
            required
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`ctx-${c.id}`}>{t.connections.context}</Label>
          <Input
            id={`ctx-${c.id}`}
            value={context}
            maxLength={80}
            placeholder={t.connections.contextHint}
            onChange={(e) => setContext(e.target.value)}
          />
        </div>
        <Button type="submit" variant="secondary" disabled={!dirty || pending}>
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
    </article>
  );
}

"use client";

import { ArrowLeft, Plus, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  CONTEXT_KINDS,
  type ContextKind,
  type ContextLinkType,
  type ContextProfile,
  type DiscoveryCatalog,
} from "@/core/contexts/model";
import type { PublicError } from "@/core/errors";
import { spaceColor, spaceIcon } from "@/core/knowledge/appearance";
import { AppearancePicker, SpaceGlyph } from "@/features/knowledge/appearance";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

import {
  archiveContextAction,
  createContextAction,
  deleteContextAction,
  updateContextAction,
} from "./actions";

export interface ContextSummary {
  id: string;
  name: string;
  kind: ContextKind;
  icon: string | null;
  accent: string | null;
  status: "active" | "archived";
  description: string | null;
  links: number;
}

const FIELD = "flex flex-col gap-1.5";
const LABEL = "text-[13px] text-muted";
const AREA =
  "min-h-20 w-full rounded-2xl border border-border bg-transparent px-4 py-3 text-[14px] outline-none focus:border-accent-line";
const SELECT =
  "h-10 rounded-full border border-border bg-transparent px-3 text-[14px] outline-none focus:border-accent-line";

function useAction() {
  const { t } = useI18n();
  const [pending, start] = useTransition();
  const act = <T,>(
    fn: () => Promise<{ ok: true; value: T } | { ok: false; error: PublicError }>,
    done?: (v: T) => void,
  ) =>
    start(async () => {
      const r = await fn();
      if (!r.ok) toast.error(r.error.message || t.errors.codes[r.error.code]);
      else done?.(r.value);
    });
  return { pending, act };
}

/** All contexts; create one by name and type, then link its sources. */
export function ContextsIndex({ contexts }: { contexts: ContextSummary[] }) {
  const { t } = useI18n();
  const c = t.myElise.contexts;
  const router = useRouter();
  const { pending, act } = useAction();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<ContextKind>("client");
  const active = contexts.filter((x) => x.status === "active");
  const archived = contexts.filter((x) => x.status === "archived");
  return (
    <div className="flex flex-col gap-6">
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          act(
            () => createContextAction({ name, kind }),
            (v) => router.push(`/my-elise/contexts/${v.id}`),
          );
        }}
      >
        <Input
          aria-label={c.name}
          placeholder={c.name}
          value={name}
          maxLength={80}
          onChange={(e) => setName(e.target.value)}
          className="w-56"
        />
        <select
          aria-label={c.kind}
          value={kind}
          onChange={(e) => setKind(e.target.value as ContextKind)}
          className={SELECT}
        >
          {CONTEXT_KINDS.map((k) => (
            <option key={k} value={k}>
              {t.workspace.context.kinds[k]}
            </option>
          ))}
        </select>
        <Button type="submit" disabled={pending || !name.trim()}>
          <Plus />
          {c.new}
        </Button>
      </form>
      {active.length === 0 ? (
        <p className="text-[14px] text-muted">{c.empty}</p>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {active.map((x) => (
            <ContextCard key={x.id} context={x} />
          ))}
        </ul>
      )}
      {archived.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="type-label text-faint">{c.archived}</h2>
          <ul className="grid gap-3 sm:grid-cols-2">
            {archived.map((x) => (
              <ContextCard key={x.id} context={x} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function ContextCard({ context: x }: { context: ContextSummary }) {
  const { t } = useI18n();
  return (
    <li>
      <Link
        href={`/my-elise/contexts/${x.id}`}
        className={cn(
          "flex items-start gap-3 rounded-2xl border border-border bg-surface p-4 transition-colors hover:border-accent/50",
          x.status === "archived" && "opacity-70",
        )}
      >
        <SpaceGlyph icon={x.icon} color={x.accent} />
        <span className="min-w-0">
          <span className="block truncate font-medium">{x.name}</span>
          <span className="block text-[12.5px] text-muted">
            {t.workspace.context.kinds[x.kind]} · {t.myElise.contexts.linksCount(x.links)}
          </span>
          {x.description && (
            <span className="mt-1 line-clamp-2 block text-[12.5px] text-faint">
              {x.description}
            </span>
          )}
        </span>
      </Link>
    </li>
  );
}

const RESOURCE_TYPES: { type: ContextLinkType; of: keyof DiscoveryCatalog }[] = [
  { type: "knowledge_space", of: "spaces" },
  { type: "task_list", of: "taskLists" },
  { type: "structured_source", of: "structuredSources" },
  { type: "native_list", of: "lists" },
  { type: "account", of: "accounts" },
];
const VALUE_TYPES: ContextLinkType[] = [
  "email_domain",
  "email_address",
  "web_domain",
  "calendar_keyword",
  "keyword",
];

function catalogOptions(catalog: DiscoveryCatalog, of: keyof DiscoveryCatalog) {
  switch (of) {
    case "spaces":
      return catalog.spaces.map((s) => ({ id: s.id, label: s.path }));
    case "taskLists":
      return catalog.taskLists.map((l) => ({ id: l.id, label: `${l.name} · ${l.source}` }));
    case "structuredSources":
      return catalog.structuredSources.map((s) => ({ id: s.id, label: s.name }));
    case "lists":
      return catalog.lists.map((l) => ({ id: l.id, label: l.name }));
    case "accounts":
      return catalog.accounts.map((a) => ({
        id: a.connectionId,
        label: a.account ? `${a.label} (${a.account})` : a.label,
      }));
  }
}

/** One context: details, where it lives, and the organizational actions. */
export function ContextEditor({
  profile,
  catalog,
  progress,
}: {
  profile: ContextProfile;
  catalog: DiscoveryCatalog;
  progress: { counts: Record<string, number>; total: number } | null;
}) {
  const { t } = useI18n();
  const c = t.myElise.contexts;
  const kinds = t.workspace.context;
  const router = useRouter();
  const { pending, act } = useAction();
  const [form, setForm] = useState({
    name: profile.name,
    description: profile.description ?? "",
    aliases: profile.aliases.join(", "),
    instructions: profile.instructions ?? "",
    targetDate: profile.study?.targetDate ?? "",
    objective: profile.study?.objective ?? "",
    level: profile.study?.level ?? "",
    icon: spaceIcon(profile.icon),
    accent: spaceColor(profile.accent),
  });
  const [linkType, setLinkType] = useState<ContextLinkType>("knowledge_space");
  const [linkValue, setLinkValue] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteStudy, setDeleteStudy] = useState(false);
  const resource = RESOURCE_TYPES.find((r) => r.type === linkType);
  const options = resource ? catalogOptions(catalog, resource.of) : [];
  const linked = new Set(profile.links.map((l) => `${l.type}:${l.resourceId ?? l.value}`));
  const archived = profile.status === "archived";

  const save = () =>
    act(
      () =>
        updateContextAction(profile.id, {
          name: form.name,
          description: form.description,
          aliases: form.aliases
            .split(",")
            .map((a) => a.trim())
            .filter(Boolean)
            .slice(0, 12),
          instructions: form.instructions,
          icon: form.icon,
          accent: form.accent,
          ...(profile.kind === "study"
            ? {
                study: {
                  targetDate: form.targetDate,
                  objective: form.objective,
                  level: form.level,
                },
              }
            : {}),
        }),
      () => {
        toast.success(c.saved);
        router.refresh();
      },
    );

  const addLink = () => {
    const label = resource ? options.find((o) => o.id === linkValue)?.label : linkValue;
    act(
      () =>
        updateContextAction(profile.id, {
          addLinks: [
            resource
              ? { type: linkType, resourceId: linkValue, label: label ?? linkValue }
              : { type: linkType, value: linkValue },
          ],
        }),
      () => {
        setLinkValue("");
        router.refresh();
      },
    );
  };

  return (
    <div className="flex flex-col gap-8">
      <Link
        href="/my-elise/contexts"
        className="inline-flex w-fit items-center gap-1.5 text-[13px] text-muted hover:text-fg"
      >
        <ArrowLeft className="size-3.5" aria-hidden />
        {c.back}
      </Link>
      <header className="flex items-center gap-3">
        <SpaceGlyph icon={form.icon} color={form.accent} size="lg" />
        <div className="min-w-0">
          <h1 className="truncate text-[28px] leading-tight font-light tracking-[-0.02em]">
            {profile.name}
          </h1>
          <p className="text-[13px] text-muted">
            {kinds.kinds[profile.kind]}
            {archived ? ` · ${c.archived}` : ""}
          </p>
        </div>
      </header>

      <form
        className="grid gap-5 md:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <label className={FIELD}>
          <span className={LABEL}>{c.name}</span>
          <Input
            value={form.name}
            maxLength={80}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </label>
        <label className={FIELD}>
          <span className={LABEL}>{c.aliases}</span>
          <Input
            value={form.aliases}
            onChange={(e) => setForm({ ...form, aliases: e.target.value })}
          />
          <span className="text-[12px] text-faint">{c.aliasesHint}</span>
        </label>
        <label className={cn(FIELD, "md:col-span-2")}>
          <span className={LABEL}>{c.description}</span>
          <textarea
            className={AREA}
            maxLength={1000}
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
          />
        </label>
        <label className={cn(FIELD, "md:col-span-2")}>
          <span className={LABEL}>{c.instructions}</span>
          <textarea
            className={AREA}
            maxLength={1000}
            value={form.instructions}
            onChange={(e) => setForm({ ...form, instructions: e.target.value })}
          />
          <span className="text-[12px] text-faint">{c.instructionsHint}</span>
        </label>
        {profile.kind === "study" && (
          <>
            <label className={FIELD}>
              <span className={LABEL}>{c.targetDate}</span>
              <Input
                type="date"
                value={form.targetDate}
                onChange={(e) => setForm({ ...form, targetDate: e.target.value })}
              />
            </label>
            <label className={FIELD}>
              <span className={LABEL}>{c.level}</span>
              <Input
                value={form.level}
                maxLength={60}
                onChange={(e) => setForm({ ...form, level: e.target.value })}
              />
            </label>
            <label className={cn(FIELD, "md:col-span-2")}>
              <span className={LABEL}>{c.objective}</span>
              <Input
                value={form.objective}
                maxLength={500}
                onChange={(e) => setForm({ ...form, objective: e.target.value })}
              />
            </label>
          </>
        )}
        <div className={cn(FIELD, "md:col-span-2")}>
          <span className={LABEL}>{c.appearance}</span>
          <AppearancePicker
            icon={form.icon}
            color={form.accent}
            onChange={(next) => setForm({ ...form, icon: next.icon, accent: next.color })}
          />
        </div>
        <div className="md:col-span-2">
          <Button type="submit" disabled={pending || !form.name.trim()}>
            {c.save}
          </Button>
        </div>
      </form>

      <section className="flex flex-col gap-3">
        <div>
          <h2 className="font-medium">{c.links}</h2>
          <p className="text-[12.5px] text-muted">{c.linksHint}</p>
        </div>
        {profile.links.length === 0 ? (
          <p className="text-[14px] text-faint">{c.noLinks}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border rounded-2xl border border-border">
            {profile.links.map((l) => (
              <li key={l.id} className="flex items-center gap-3 px-4 py-2.5">
                <span className="w-36 shrink-0 text-[12.5px] text-faint">
                  {kinds.linkTypes[l.type] ?? l.type}
                </span>
                <span className="min-w-0 flex-1 truncate text-[14px]">{l.label}</span>
                {!l.confirmed && <span className="text-[12px] text-faint">{c.suggested}</span>}
                <button
                  type="button"
                  aria-label={`${c.removeLink}: ${l.label}`}
                  disabled={pending}
                  onClick={() =>
                    act(
                      () => updateContextAction(profile.id, { removeLinkIds: [l.id] }),
                      () => router.refresh(),
                    )
                  }
                  className="grid size-8 place-items-center rounded-full text-muted hover:bg-active hover:text-fg"
                >
                  <X className="size-4" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        )}
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (linkValue.trim()) addLink();
          }}
        >
          <select
            aria-label={c.linkType}
            value={linkType}
            onChange={(e) => {
              setLinkType(e.target.value as ContextLinkType);
              setLinkValue("");
            }}
            className={SELECT}
          >
            {[...RESOURCE_TYPES.map((r) => r.type), ...VALUE_TYPES].map((type) => (
              <option key={type} value={type}>
                {kinds.linkTypes[type]}
              </option>
            ))}
          </select>
          {resource ? (
            <select
              aria-label={c.linkValue}
              value={linkValue}
              onChange={(e) => setLinkValue(e.target.value)}
              className={cn(SELECT, "min-w-56")}
            >
              <option value="">{c.pick}</option>
              {options
                .filter((o) => !linked.has(`${linkType}:${o.id}`))
                .map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
            </select>
          ) : (
            <Input
              aria-label={c.linkValue}
              value={linkValue}
              maxLength={320}
              placeholder={
                linkType === "email_domain"
                  ? "@rsfa.co.nz"
                  : linkType === "web_domain"
                    ? "rsfa.co.nz"
                    : linkType === "email_address"
                      ? "rod@rsfa.co.nz"
                      : profile.name
              }
              onChange={(e) => setLinkValue(e.target.value)}
              className="w-60"
            />
          )}
          <Button type="submit" variant="secondary" disabled={pending || !linkValue.trim()}>
            <Plus />
            {c.addLink}
          </Button>
        </form>
      </section>

      {progress && progress.total > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="font-medium">{c.progress}</h2>
          <ul className="flex flex-wrap gap-2">
            {(["needs_review", "learning", "understood", "not_reviewed"] as const).map((k) => (
              <li key={k} className="rounded-xl border border-border px-3 py-2 text-[13px]">
                <span className="font-mono">{progress.counts[k] ?? 0}</span>{" "}
                <span className="text-muted">{t.workspace.study.status[k]}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="flex flex-wrap gap-2 border-t border-border pt-6">
        <Button
          variant="secondary"
          disabled={pending}
          onClick={() =>
            act(
              () => archiveContextAction(profile.id, !archived),
              () => router.refresh(),
            )
          }
        >
          {archived ? c.restore : c.archive}
        </Button>
        <Button variant="ghost" disabled={pending} onClick={() => setDeleting(true)}>
          {c.delete}
        </Button>
      </section>

      <Dialog
        open={deleting}
        onClose={() => setDeleting(false)}
        title={c.delete}
        description={c.deleteConfirm(profile.name)}
        busy={pending}
      >
        <div className="flex flex-col gap-4">
          {progress && progress.total > 0 && (
            <label className="flex items-center gap-2 text-[14px]">
              <input
                type="checkbox"
                checked={deleteStudy}
                onChange={(e) => setDeleteStudy(e.target.checked)}
                className="size-4 accent-[var(--color-accent)]"
              />
              {c.deleteStudy}
            </label>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setDeleting(false)}>
              {c.cancel}
            </Button>
            <Button
              variant="danger"
              disabled={pending || (Boolean(progress?.total) && !deleteStudy)}
              onClick={() =>
                act(
                  () => deleteContextAction(profile.id, deleteStudy),
                  () => router.push("/my-elise/contexts"),
                )
              }
            >
              {c.delete}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}

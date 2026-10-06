"use client";

import { BookOpenCheck, Download, FileUp, Plus, RotateCcw, Sparkles, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import type { MethodCard, MethodDetail } from "@/application/methods-service";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Select } from "@/components/ui/input";
import {
  needsDesktop,
  REFERENCE_KINDS,
  type ReferenceKind,
  type SpaceRef,
} from "@/core/skills/model";
import { serverTransport } from "@/features/chat/draft-attachments";
import { useRelative } from "@/features/knowledge/ui";
import { errorText } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

import {
  addFileReferenceAction,
  addTextReferenceAction,
  createMethodAction,
  draftMethodAction,
  exportMethodAction,
  importMethodAction,
  methodDetailAction,
  removeReferenceAction,
  rollbackMethodAction,
  setMethodStatusAction,
  updateMethodAction,
  type MethodResult,
} from "./actions";

const TEXTAREA =
  "w-full resize-y rounded-xl border border-border bg-surface px-3 py-2.5 text-sm text-fg placeholder:text-muted/70 hover:border-border-strong focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent-soft focus-visible:outline-none";
const MATERIAL_ACCEPT = ".pdf,.docx,.md,.markdown,.txt";

export interface MethodDraftInput {
  name: string;
  description: string;
  instructions: string;
  hints: string;
  spaceId: string | null;
  /** Created from this Knowledge document (kept as its source). */
  itemId?: string;
}

/**
 * Methods (ADR-040 §J): cards inside a Space (or every Method, in My Elise), a plain editor,
 * natural-language creation, import/export, supporting material and version history. No
 * YAML, no schemas: a name, what it's for, and the instructions.
 */
export function MethodsPanel({
  methods,
  spaces,
  space = null,
  opened = null,
  initialDraft = null,
  heading = true,
}: {
  methods: MethodCard[];
  spaces: SpaceRef[];
  /** The Space or Section page this panel is on; null = every Method (My Elise). */
  space?: SpaceRef | null;
  /** A Method to open at once (`?method=`), already loaded. */
  opened?: MethodDetail | null;
  initialDraft?: MethodDraftInput | null;
  heading?: boolean;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const relative = useRelative();
  const [editing, setEditing] = useState<{
    detail: MethodDetail | null;
    draft: MethodDraftInput | null;
  } | null>(
    opened
      ? { detail: opened, draft: null }
      : initialDraft
        ? { detail: null, draft: initialDraft }
        : null,
  );
  /** Opens a saved Method: its versions and material load first. */
  async function open(id: string) {
    const r = await methodDetailAction(id);
    if (!r.ok) return void toast.error(errorText(t, r.error));
    setEditing({ detail: r.value, draft: null });
  }
  const [showArchived, setShowArchived] = useState(false);
  const importInput = useRef<HTMLInputElement>(null);
  const [pending, start] = useTransition();
  const tm = t.methods;
  const active = methods.filter((m) => m.status === "active");
  const archived = methods.filter((m) => m.status === "archived");
  const parent = space?.parentId ? spaces.find((s) => s.id === space.parentId) : null;

  async function onImport(file: File | undefined) {
    if (!file) return;
    const r = await importMethodAction(
      await file.text(),
      file.name,
      space?.general ? null : (space?.id ?? null),
    );
    if (!r.ok) return void toast.error(errorText(t, r.error));
    toast.success(tm.imported);
    await open(r.value.id);
    router.refresh();
  }

  const groups: { key: string; title: string | null; items: MethodCard[] }[] = space
    ? [{ key: "here", title: null, items: active }]
    : [
        { key: "global", title: tm.globalTitle, items: active.filter((m) => !m.spaceId) },
        ...[...new Set(active.filter((m) => m.spaceId).map((m) => m.scopeLabel))]
          .sort()
          .map((label) => ({
            key: label,
            title: label,
            items: active.filter((m) => m.spaceId && m.scopeLabel === label),
          })),
      ];

  return (
    <section className="flex flex-col gap-3" aria-label={tm.title}>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          {heading && <h2 className="type-label text-faint">{tm.title}</h2>}
          <p className="text-[13px] text-muted">
            {space
              ? space.general
                ? tm.generalHint
                : parent
                  ? tm.sectionHint(parent.name)
                  : tm.spaceHint(space.name)
              : tm.subtitle}
          </p>
        </div>
        <div className="flex gap-1">
          <input
            ref={importInput}
            type="file"
            accept=".md,.markdown,.txt"
            className="sr-only"
            tabIndex={-1}
            onChange={(e) => {
              void onImport(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
          <Button size="sm" variant="ghost" onClick={() => importInput.current?.click()}>
            <FileUp />
            {tm.import}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setEditing({ detail: null, draft: null })}
          >
            <Plus />
            {tm.new}
          </Button>
        </div>
      </div>

      {active.length === 0 ? (
        <div className="flex flex-col items-start gap-2 rounded-2xl border border-dashed border-border p-5">
          <p className="flex items-center gap-2 text-[14px] text-muted">
            <BookOpenCheck className="size-4 shrink-0 text-faint" aria-hidden />
            {tm.empty}
          </p>
          <p className="text-[13px] text-faint">
            {space?.general ? tm.generalExample : tm.emptyExample}
          </p>
        </div>
      ) : (
        groups
          .filter((g) => g.items.length)
          .map((g) => (
            <div key={g.key} className="flex flex-col gap-2">
              {g.title && (
                <h3 className="text-[13px] font-medium text-muted">
                  {g.title}
                  {g.key === "global" && (
                    <span className="font-normal text-faint"> · {tm.globalHint}</span>
                  )}
                </h3>
              )}
              <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {g.items.map((m) => (
                  <li key={m.id}>
                    <button
                      type="button"
                      onClick={() => void open(m.id)}
                      className="flex h-full w-full flex-col gap-1 rounded-2xl border border-border bg-surface px-4 py-3 text-left transition-colors hover:border-accent/50"
                    >
                      <span className="flex items-center gap-2 text-[14.5px] font-medium">
                        <BookOpenCheck className="size-4 shrink-0 text-accent" aria-hidden />
                        <span className="truncate">{m.name}</span>
                      </span>
                      <span className="line-clamp-2 text-[12.5px] text-muted">{m.description}</span>
                      <span className="mt-auto pt-1 text-[11.5px] text-faint">
                        {space && m.spaceId !== space.id ? `${m.scopeLabel} · ` : ""}
                        {tm.updated(relative(m.updatedAt))}
                        {needsDesktop(m) && ` · ${tm.desktop}`}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))
      )}

      {archived.length > 0 && (
        <div className="flex flex-col gap-2">
          <button
            type="button"
            className="self-start text-[12.5px] text-muted hover:text-fg"
            onClick={() => setShowArchived((v) => !v)}
          >
            {tm.showArchived(archived.length)}
          </button>
          {showArchived && (
            <ul className="flex flex-col divide-y divide-border rounded-2xl border border-border">
              {archived.map((m) => (
                <li key={m.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                  <span className="min-w-0 truncate text-[13.5px] text-muted">{m.name}</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={pending}
                    onClick={() =>
                      start(async () => {
                        const r = await setMethodStatusAction(m.id, "active");
                        if (!r.ok) return void toast.error(errorText(t, r.error));
                        toast.success(tm.unarchived);
                        router.refresh();
                      })
                    }
                  >
                    <RotateCcw />
                    {tm.unarchive}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <MethodEditor
        key={editing ? (editing.detail?.method.id ?? "new") : "closed"}
        open={Boolean(editing)}
        initialDetail={editing?.detail ?? null}
        initial={editing?.draft ?? null}
        spaces={spaces}
        // General Knowledge's Methods are the workspace-wide ones (ADR-047).
        defaultSpaceId={space?.general ? null : (space?.id ?? null)}
        onClose={() => setEditing(null)}
        onSaved={(id) => {
          void open(id);
          router.refresh();
        }}
      />
    </section>
  );
}

const formOf = ({ method: m }: MethodDetail): MethodDraftInput => ({
  name: m.name,
  description: m.description,
  instructions: m.instructions,
  hints: m.hints.join(", "),
  spaceId: m.spaceId,
});

function MethodEditor({
  open,
  initialDetail,
  initial,
  spaces,
  defaultSpaceId,
  onClose,
  onSaved,
}: {
  open: boolean;
  initialDetail: MethodDetail | null;
  initial: MethodDraftInput | null;
  spaces: SpaceRef[];
  defaultSpaceId: string | null;
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const { t } = useI18n();
  const tm = t.methods;
  const router = useRouter();
  const [detail, setDetail] = useState<MethodDetail | null>(initialDetail);
  const methodId = detail?.method.id ?? null;
  const [form, setForm] = useState<MethodDraftInput>(
    initialDetail
      ? formOf(initialDetail)
      : (initial ?? {
          name: "",
          description: "",
          instructions: "",
          hints: "",
          spaceId: defaultSpaceId,
        }),
  );
  const [summary, setSummary] = useState("");
  const [tell, setTell] = useState("");
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [paste, setPaste] = useState<{ kind: ReferenceKind; title: string; content: string }>({
    kind: "example",
    title: "",
    content: "",
  });
  const [refKind, setRefKind] = useState<ReferenceKind>("template");
  const fileInput = useRef<HTMLInputElement>(null);

  async function reload(id: string) {
    const r = await methodDetailAction(id);
    if (!r.ok) return void toast.error(errorText(t, r.error));
    setDetail(r.value);
    setForm(formOf(r.value));
  }

  async function act<T>(fn: () => Promise<MethodResult<T>>, ok?: string) {
    setBusy(true);
    const r = await fn();
    setBusy(false);
    if (!r.ok) {
      toast.error(errorText(t, r.error));
      return null;
    }
    if (ok) toast.success(ok);
    return r.value;
  }

  async function save() {
    const input = { ...form };
    if (methodId) {
      const r = await act(() => updateMethodAction(methodId, input, summary), tm.saved);
      if (r) {
        setSummary("");
        await reload(methodId);
        router.refresh();
      }
    } else {
      const r = await act(() => createMethodAction(input, initial?.itemId), tm.saved);
      if (r) onSaved(r.id);
    }
  }

  async function draft() {
    const r = await act(() => draftMethodAction(tell));
    if (r) {
      setForm((f) => ({ ...f, ...r, hints: r.hints.join(", ") }));
      toast(tm.drafted);
    }
  }

  async function addFile(file: File | undefined) {
    if (!file || !methodId) return;
    setUploading(true);
    try {
      const staged = await serverTransport.stage(file);
      if (!staged.ok) return void toast.error(errorText(t, staged.error));
      if (!(await serverTransport.put(staged, file)))
        return void toast.error(t.errors.codes.PROVIDER_UNAVAILABLE);
      const done = await serverTransport.complete(staged.id);
      if (!done.ok) return void toast.error(errorText(t, done.error));
      const r = await act(() => addFileReferenceAction(methodId, staged.id, refKind));
      if (r !== null) await reload(methodId);
    } finally {
      setUploading(false);
    }
  }

  async function download() {
    if (!methodId) return;
    const r = await act(() => exportMethodAction(methodId));
    if (!r) return;
    const url = URL.createObjectURL(new Blob([r.markdown], { type: "text/markdown" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: r.fileName });
    a.click();
    URL.revokeObjectURL(url);
  }

  const m = detail?.method;
  const set = (k: keyof MethodDraftInput) => (v: string) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <Dialog
      open={open}
      onClose={onClose}
      busy={busy}
      title={methodId ? tm.edit : tm.new}
      description={tm.safety}
      className="sm:max-w-2xl"
    >
      <div className="flex flex-col gap-4">
        {!methodId && (
          <div className="flex flex-col gap-2 rounded-2xl border border-border bg-surface-2/40 p-3">
            <Label htmlFor="method-tell">{tm.tell}</Label>
            <textarea
              id="method-tell"
              data-autofocus
              rows={3}
              value={tell}
              placeholder={tm.tellPlaceholder}
              onChange={(e) => setTell(e.target.value)}
              className={TEXTAREA}
            />
            <Button
              size="sm"
              variant="secondary"
              className="self-start"
              disabled={busy || tell.trim().length < 10}
              onClick={() => void draft()}
            >
              <Sparkles />
              {busy ? tm.drafting : tm.tellAction}
            </Button>
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="method-name">{tm.name}</Label>
            <Input
              id="method-name"
              value={form.name}
              maxLength={120}
              placeholder={tm.namePlaceholder}
              onChange={(e) => set("name")(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="method-space">{tm.where}</Label>
            <Select
              id="method-space"
              value={form.spaceId ?? ""}
              onChange={(e) => setForm((f) => ({ ...f, spaceId: e.target.value || null }))}
            >
              <option value="">{tm.everywhere}</option>
              {spaces
                .filter((s) => !s.general)
                .sort((a, b) => a.path.localeCompare(b.path))
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.path}
                  </option>
                ))}
            </Select>
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="method-description">{tm.description}</Label>
          <Input
            id="method-description"
            value={form.description}
            maxLength={300}
            placeholder={tm.descriptionPlaceholder}
            onChange={(e) => set("description")(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="method-instructions">{tm.instructions}</Label>
          <textarea
            id="method-instructions"
            rows={10}
            value={form.instructions}
            maxLength={12000}
            onChange={(e) => set("instructions")(e.target.value)}
            className={cn(TEXTAREA, "font-[inherit] leading-relaxed")}
          />
          <p className="text-[12px] text-faint">{tm.instructionsHint}</p>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="method-hints">{tm.hints}</Label>
          <Input
            id="method-hints"
            value={form.hints}
            placeholder={tm.hintsPlaceholder}
            onChange={(e) => set("hints")(e.target.value)}
          />
        </div>
        {m && needsDesktop(m) && <p className="text-[12.5px] text-approval-text">{tm.desktop}</p>}
        {methodId && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="method-summary">{tm.changeSummary}</Label>
            <Input
              id="method-summary"
              value={summary}
              maxLength={200}
              onChange={(e) => setSummary(e.target.value)}
            />
          </div>
        )}

        <section className="flex flex-col gap-2 border-t border-border pt-4">
          <h3 className="text-[13px] font-medium">{tm.material}</h3>
          <p className="text-[12.5px] text-muted">{methodId ? tm.materialHint : tm.saveFirst}</p>
          {detail && detail.references.length > 0 && (
            <ul className="flex flex-col gap-1">
              {detail.references.map((r) => (
                <li
                  key={r.id}
                  className="flex items-center justify-between gap-2 rounded-xl bg-surface-2/50 px-3 py-2 text-[13px]"
                >
                  <span className="min-w-0 truncate">
                    <span className="text-faint">{tm.kinds[r.kind]} · </span>
                    {r.title}
                  </span>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={tm.remove}
                    disabled={busy}
                    onClick={() =>
                      void act(() => removeReferenceAction(methodId!, r.id)).then(
                        (x) => x !== null && reload(methodId!),
                      )
                    }
                  >
                    <X />
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {methodId && (
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <Select
                  aria-label={tm.material}
                  className="h-8 w-auto text-[13px]"
                  value={refKind}
                  onChange={(e) => setRefKind(e.target.value as ReferenceKind)}
                >
                  {REFERENCE_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {tm.kinds[k]}
                    </option>
                  ))}
                </Select>
                <input
                  ref={fileInput}
                  type="file"
                  accept={MATERIAL_ACCEPT}
                  className="sr-only"
                  tabIndex={-1}
                  onChange={(e) => {
                    void addFile(e.target.files?.[0]);
                    e.target.value = "";
                  }}
                />
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={uploading || busy}
                  onClick={() => fileInput.current?.click()}
                >
                  <FileUp />
                  {uploading ? tm.uploading : tm.addFile}
                </Button>
              </div>
              <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
                <Input
                  aria-label={tm.pasteTitle}
                  placeholder={tm.pasteTitle}
                  value={paste.title}
                  maxLength={200}
                  onChange={(e) => setPaste((p) => ({ ...p, title: e.target.value }))}
                />
                <Select
                  aria-label={tm.material}
                  value={paste.kind}
                  onChange={(e) =>
                    setPaste((p) => ({ ...p, kind: e.target.value as ReferenceKind }))
                  }
                >
                  {REFERENCE_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {tm.kinds[k]}
                    </option>
                  ))}
                </Select>
              </div>
              <textarea
                aria-label={tm.pasteText}
                placeholder={tm.pasteText}
                rows={3}
                value={paste.content}
                onChange={(e) => setPaste((p) => ({ ...p, content: e.target.value }))}
                className={TEXTAREA}
              />
              <Button
                size="sm"
                variant="ghost"
                className="self-start"
                disabled={busy || !paste.title.trim() || !paste.content.trim()}
                onClick={() =>
                  void act(() => addTextReferenceAction(methodId, paste)).then(async (x) => {
                    if (x === null) return;
                    setPaste({ kind: "example", title: "", content: "" });
                    await reload(methodId);
                  })
                }
              >
                <Plus />
                {tm.addText}
              </Button>
            </div>
          )}
        </section>

        {detail && detail.versions.length > 0 && (
          <section className="flex flex-col gap-2 border-t border-border pt-4">
            <h3 className="text-[13px] font-medium">{tm.history}</h3>
            <ul className="flex max-h-48 flex-col gap-1 overflow-y-auto">
              {detail.versions.map((v) => (
                <li key={v.version} className="flex items-center justify-between gap-2 text-[13px]">
                  <span className="min-w-0 truncate">
                    <span className="font-mono text-faint">v{v.version}</span> {v.changeSummary}
                    {v.version === detail.method.version && (
                      <span className="text-faint"> · {tm.current}</span>
                    )}
                  </span>
                  {v.version !== detail.method.version && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() =>
                        void act(
                          () => rollbackMethodAction(methodId!, v.version),
                          tm.restored(v.version),
                        ).then(async (x) => {
                          if (x === null) return;
                          await reload(methodId!);
                          router.refresh();
                        })
                      }
                    >
                      <RotateCcw />
                      {tm.restore}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-4">
          <div className="flex gap-1">
            {methodId && (
              <>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => void download()}>
                  <Download />
                  {tm.export}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    void act(() => setMethodStatusAction(methodId, "archived"), tm.archived).then(
                      (x) => {
                        if (x === null) return;
                        onClose();
                        router.refresh();
                      },
                    )
                  }
                >
                  {tm.archive}
                </Button>
              </>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" disabled={busy} onClick={onClose}>
              {tm.cancel}
            </Button>
            <Button
              disabled={
                busy || !form.name.trim() || !form.description.trim() || !form.instructions.trim()
              }
              onClick={() => void save()}
            >
              {tm.save}
            </Button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}

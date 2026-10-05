"use client";

import { BookOpenCheck } from "lucide-react";
import Link from "next/link";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import type { ToolDisplay } from "@/core/agents/tools";
import { errorText } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";

import { rollbackMethodAction, setMethodStatusAction } from "./actions";

/**
 * "Actualicé el método · Crear propuesta comercial" with View / Undo (ADR-040 §H2, §N): a quiet
 * line, never a card that competes with the answer. Undo is itself a version, so it's reversible.
 */
export function MethodLine({
  display,
  embedded = false,
}: {
  display: Extract<ToolDisplay, { kind: "method" }>;
  embedded?: boolean;
}) {
  const { t } = useI18n();
  const tm = t.methods.card;
  const [pending, start] = useTransition();
  const [undone, setUndone] = useState(false);
  const { method, change, previousVersion } = display;

  const undo =
    change === "archived"
      ? () => setMethodStatusAction(method.id, "active")
      : change === "created"
        ? () => setMethodStatusAction(method.id, "archived")
        : (change === "updated" || change === "restored") && previousVersion
          ? () => rollbackMethodAction(method.id, previousVersion)
          : null;

  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-muted">
      <BookOpenCheck className="size-3.5 shrink-0 text-accent" aria-hidden />
      <span>
        {tm[change]} · <span className="text-fg">{method.name}</span>
        {change === "updated" && display.summary && (
          <span className="text-faint"> — {display.summary}</span>
        )}
      </span>
      {!embedded && (
        <>
          <Link
            href={`/my-elise/methods?method=${method.id}`}
            className="text-accent-text underline-offset-2 hover:underline"
          >
            {tm.view}
          </Link>
          {undo && !undone && (
            <button
              type="button"
              disabled={pending}
              className="text-accent-text underline-offset-2 hover:underline disabled:opacity-60"
              onClick={() =>
                start(async () => {
                  const r = await undo();
                  if (!r.ok) return void toast.error(errorText(t, r.error));
                  setUndone(true);
                  toast.success(tm.undone);
                })
              }
            >
              {tm.undo}
            </button>
          )}
        </>
      )}
    </p>
  );
}

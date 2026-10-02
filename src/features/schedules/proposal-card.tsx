"use client";

import { motion, type MotionProps } from "motion/react";
import Link from "next/link";
import { useState, useTransition } from "react";

import type { ToolDisplay } from "@/core/agents/tools";
import { briefCapabilities } from "@/core/schedules/schedule";
import { errorText } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";

import { createScheduleAction } from "./actions";
import { describeInstant, describeWhen } from "./format";

type Proposal = Extract<ToolDisplay, { kind: "schedule_proposal" }>;

/** ELISE's structured reading of the request. Nothing exists until the user presses Create. */
export function ScheduleProposalCard({ display, rise }: { display: Proposal; rise: MotionProps }) {
  const { t, locale } = useI18n();
  const [pending, startTransition] = useTransition();
  const [created, setCreated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { input } = display;
  // base64url of the UTF-8 JSON (the page re-validates it; Buffer is not available here).
  const draft = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(input))))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  return (
    <motion.section
      {...rise}
      aria-label={t.schedules.proposal}
      className="flex flex-col gap-2 rounded-2xl border border-border bg-surface px-4 py-3.5 md:px-5 md:py-[18px]"
    >
      <span className="type-label text-faint">
        {t.schedules.proposal}
        {created && ` · ${t.schedules.created}`}
      </span>
      <p className="text-base font-medium tracking-[-0.01em] md:text-lg">{input.name}</p>
      <dl className="grid grid-cols-[80px_minmax(0,1fr)] gap-x-3 gap-y-1 text-[13.5px]">
        <dt className="text-faint">{t.schedules.form.repeat}</dt>
        <dd>{describeWhen(input.definition, t, locale)}</dd>
        <dt className="text-faint">{t.schedules.form.timezone}</dt>
        <dd>{input.timezone}</dd>
        <dt className="text-faint">{t.schedules.uses}</dt>
        <dd>
          {briefCapabilities(input.configuration)
            .map((c) => t.capabilities[c])
            .join(", ")}
        </dd>
        <dt className="text-faint">{t.schedules.form.notify}</dt>
        <dd>{t.schedules.notify[input.delivery.notify]}</dd>
        {input.instructions && (
          <>
            <dt className="text-faint">{t.schedules.form.instructions}</dt>
            <dd className="text-muted">{input.instructions}</dd>
          </>
        )}
      </dl>
      <p className="text-[13px] text-faint">
        {t.schedules.firstRun(describeInstant(display.nextRunAt, input.timezone, t, locale))}
      </p>
      <div className="flex flex-wrap items-center gap-2 pt-1">
        {created ? (
          <Link href="/schedules" className="text-[13.5px] text-accent-text">
            {t.schedules.viewSchedules}
          </Link>
        ) : (
          <>
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  const result = await createScheduleAction(input);
                  if (result.ok) setCreated(true);
                  else setError(errorText(t, result.error));
                })
              }
              className="h-10 rounded-full bg-fg px-[18px] text-sm font-medium text-bg disabled:opacity-60"
            >
              {t.schedules.form.create}
            </button>
            <Link
              href={`/schedules?draft=${draft}`}
              className="flex h-10 items-center rounded-full px-4 text-sm text-muted hover:text-fg"
            >
              {t.schedules.edit}
            </Link>
          </>
        )}
      </div>
      {error && (
        <p role="alert" className="text-[13px] text-danger-text">
          {error}
        </p>
      )}
    </motion.section>
  );
}

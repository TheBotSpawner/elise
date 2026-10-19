"use client";

import { CreditCard } from "lucide-react";

import { SettingsPage } from "@/features/settings/shell";
import { useI18n } from "@/lib/i18n/client";

/**
 * Billing (ADR-068): honest until plans exist — no plan, card, invoice or price is shown or
 * invented. Plans, subscriptions and payment methods will live here.
 */
export function View() {
  const { t } = useI18n();
  const b = t.settingsHub.billing;
  return (
    <SettingsPage section="billing">
      <div className="flex flex-col items-start gap-3 rounded-2xl border border-border bg-surface p-5 md:p-6">
        <span className="grid size-10 place-items-center rounded-xl bg-accent-soft text-accent-text">
          <CreditCard className="size-5" strokeWidth={1.6} aria-hidden />
        </span>
        <p className="text-[15px]">{b.body}</p>
        <p className="text-[13.5px] text-muted">{b.later}</p>
      </div>
    </SettingsPage>
  );
}

"use client";

import { useI18n } from "@/lib/i18n/client";

import { InfoTip } from "./info-tip";

/**
 * The ⓘ next to a section's title: what the section is, in the same small anchored card as every
 * other ELISE help (InfoTip) — the page stays in view, nothing is dimmed or blurred.
 */
export function PageInfo({ title, body }: { title: string; body: string[] }) {
  const { t } = useI18n();
  return <InfoTip label={t.common.aboutSection(title)} title={title} body={body} size="lg" />;
}

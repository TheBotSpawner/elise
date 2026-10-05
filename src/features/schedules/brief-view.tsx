"use client";

import { useEffect, useMemo } from "react";

import type { MorningBrief } from "@/core/briefs/morning-brief";
import { briefExperience } from "@/core/schedules/experience";
import { useI18n } from "@/lib/i18n/client";

import { markResultReadAction } from "./actions";
import { ExperienceView } from "./experience-view";

export { warningText } from "./experience-view";

/**
 * A Morning Brief (or any preset built on it) as a Scheduled Experience (ADR-039): ELISE
 * presents it segment by segment, with its cards. Without a `resultId` it is the brief ELISE
 * just assembled in a conversation, where the conversation does the talking.
 */
export function BriefView({
  resultId,
  brief,
  createdAt,
  unread,
  title,
}: {
  resultId?: string;
  brief: MorningBrief;
  createdAt: string;
  unread: boolean;
  /** The schedule's own name ("Weekly planning"); the Morning Brief when absent. */
  title?: string;
}) {
  const { t, locale } = useI18n();
  useEffect(() => {
    if (unread && resultId) void markResultReadAction(resultId);
  }, [resultId, unread]);
  const experience = useMemo(() => briefExperience(brief, locale), [brief, locale]);
  const day = new Intl.DateTimeFormat(locale, {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: brief.timezone,
  });
  return (
    <ExperienceView
      experience={experience}
      title={title ?? t.brief.title}
      eyebrow={day.format(new Date(createdAt))}
      narrate={Boolean(resultId)}
    />
  );
}

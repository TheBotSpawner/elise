import "server-only";

import { logger } from "./logger";

/**
 * Product events (ADR-019), privacy-safe by construction: a fixed set of names and small
 * primitive properties (counts, kinds, sources) — never message text, titles, emails or file
 * names. Today they go to the structured log as `product.event`; a provider (PostHog, Segment…)
 * plugs in with setAnalyticsSink without touching call sites.
 */
export const PRODUCT_EVENTS = [
  "onboarding_completed",
  "onboarding_skipped",
  "connection_added",
  "first_successful_turn",
  "space_created",
  "section_created",
  "study_started",
  "work_brief_run",
  "voice_used",
  "shortcut_run",
] as const;
export type ProductEvent = (typeof PRODUCT_EVENTS)[number];

type Props = Record<string, string | number | boolean | null>;
type Sink = (event: {
  name: ProductEvent;
  workspaceId: string;
  userId: string;
  props: Props;
}) => void;

let sink: Sink | null = null;

export function setAnalyticsSink(next: Sink | null) {
  sink = next;
}

/** Strings are capped short: these are enums ("onboarding", "voice"), not content. */
function clean(props: Props): Props {
  return Object.fromEntries(
    Object.entries(props).map(([k, v]) => [k, typeof v === "string" ? v.slice(0, 40) : v]),
  );
}

export function trackEvent(
  who: { workspaceId: string; userId: string },
  name: ProductEvent,
  props: Props = {},
): void {
  const safe = clean(props);
  logger.info("product.event", {
    name,
    workspace_id: who.workspaceId,
    user_id: who.userId,
    ...safe,
  });
  try {
    sink?.({ name, workspaceId: who.workspaceId, userId: who.userId, props: safe });
  } catch {
    // Analytics never breaks the product.
  }
}

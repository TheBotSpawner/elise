/**
 * Entitlements (ADR-019): what a workspace may use and how much. Billing readiness only —
 * there are no plans or prices yet. Every workspace gets the MVP entitlements; a future plan
 * changes this table, not feature code.
 */
import { WEB_LIMITS } from "./web/model";

export type EntitledFeature =
  "voice" | "wake_phrase" | "web_research" | "knowledge_storage" | "scheduled_runs" | "study";

export interface FeatureEntitlement {
  enabled: boolean;
  /** Usage ceiling per period, where the feature has one. */
  limit?: { amount: number; per: "day" | "month" | "total"; unit: string };
}

export type Entitlements = Record<EntitledFeature, FeatureEntitlement>;

export const MVP_ENTITLEMENTS: Entitlements = {
  voice: { enabled: true },
  wake_phrase: { enabled: true },
  web_research: {
    enabled: true,
    limit: { amount: WEB_LIMITS.dailySearches, per: "day", unit: "searches" },
  },
  knowledge_storage: { enabled: true },
  scheduled_runs: { enabled: true },
  study: { enabled: true },
};

/** ponytail: one plan for every workspace; look the workspace's plan up once plans exist. */
export function entitlementsFor(): Entitlements {
  return MVP_ENTITLEMENTS;
}

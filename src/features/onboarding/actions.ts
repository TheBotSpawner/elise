"use server";

import { redirect } from "next/navigation";
import { z } from "zod";

import { requireAuthContext } from "@/application/auth-context";
import { createExecutorPorts, toolContext } from "@/application/elise";
import { createSpace } from "@/application/knowledge-service";
import { toPublicError, type PublicError } from "@/core/errors";
import { trackEvent } from "@/infrastructure/observability/analytics";

import {
  ONBOARDING_STEPS,
  PRESET_APPEARANCE,
  SPACE_PRESETS,
  type OnboardingProgress,
} from "./model";

const PROGRESS_KEY = "onboarding.progress";

const progressSchema = z.object({
  step: z.enum(ONBOARDING_STEPS),
  spacePreset: z.enum(SPACE_PRESETS).nullable().optional(),
  spaceId: z.uuid().nullable().optional(),
});

/** Remembers where the user is, so returning from Google or Notion resumes the same step. */
export async function saveOnboardingProgress(input: OnboardingProgress): Promise<void> {
  const progress = progressSchema.parse(input);
  const auth = await requireAuthContext();
  await auth.db.from("user_preferences").upsert(
    {
      workspace_id: auth.workspaceId,
      user_id: auth.userId,
      key: PROGRESS_KEY,
      value_json: progress,
      source: "onboarding",
    },
    { onConflict: "workspace_id,user_id,key" },
  );
}

const spaceSchema = z.object({
  preset: z.enum(SPACE_PRESETS),
  name: z.string().trim().min(1).max(80),
});

/** The first Space, through the same service (and checks) as Knowledge. */
export async function createFirstSpace(
  input: z.input<typeof spaceSchema>,
): Promise<{ ok: true; spaceId: string } | { ok: false; error: PublicError }> {
  try {
    const data = spaceSchema.parse(input);
    const auth = await requireAuthContext();
    const spaceId = await createSpace(auth, { name: data.name, ...PRESET_APPEARANCE[data.preset] });
    trackEvent(auth, "space_created", { source: "onboarding", preset: data.preset });
    return { ok: true, spaceId };
  } catch (error) {
    return { ok: false, error: toPublicError(error) };
  }
}

/**
 * Ends onboarding (finished or skipped) and lands on Home — never on a settings page. Home
 * offers a first prompt built from what was set up (`?welcome=1`).
 */
export async function completeOnboarding(input: { skipped: boolean }): Promise<void> {
  const { skipped } = z.object({ skipped: z.boolean() }).parse(input);
  const auth = await requireAuthContext();
  // The progress row stays: Home reads it once for the first prompt (e.g. a University Space).
  await auth.db
    .from("user_profiles")
    .update({ onboarding_status: skipped ? "skipped" : "completed" })
    .eq("id", auth.userId);
  await createExecutorPorts(auth).log.audit(toolContext(auth, "user_ui"), {
    eventType: skipped ? "onboarding.skipped" : "onboarding.completed",
    result: "success",
    metadata: {},
  });
  trackEvent(auth, skipped ? "onboarding_skipped" : "onboarding_completed");
  redirect("/?welcome=1");
}

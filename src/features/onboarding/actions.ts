"use server";

import { redirect } from "next/navigation";
import { z } from "zod";

import { requireAuthContext } from "@/application/auth-context";
import { createExecutorPorts, toolContext } from "@/application/elise";
import { CAPABILITY_KEYS } from "@/core/capabilities/registry";
import { isValidTimezone } from "@/core/time";

const onboardingSchema = z.object({
  capabilities: z
    .array(z.enum(CAPABILITY_KEYS as [string, ...string[]]))
    .max(CAPABILITY_KEYS.length),
  timezone: z.string().refine(isValidTimezone),
  skipped: z.boolean(),
});

/** Saves onboarding choices; capability interest adapts later setup, it grants nothing. */
export async function completeOnboarding(input: z.input<typeof onboardingSchema>): Promise<void> {
  const data = onboardingSchema.parse(input);
  const auth = await requireAuthContext();
  await auth.db.from("user_preferences").upsert(
    {
      workspace_id: auth.workspaceId,
      user_id: auth.userId,
      key: "onboarding.capabilities",
      value_json: data.capabilities,
      source: "onboarding",
    },
    { onConflict: "workspace_id,user_id,key" },
  );
  await auth.db
    .from("user_profiles")
    .update({ onboarding_status: data.skipped ? "skipped" : "completed", timezone: data.timezone })
    .eq("id", auth.userId);
  await createExecutorPorts(auth).log.audit(toolContext(auth, "user_ui"), {
    eventType: data.skipped ? "onboarding.skipped" : "onboarding.completed",
    result: "success",
    metadata: { capabilities: data.capabilities },
  });
  redirect("/");
}

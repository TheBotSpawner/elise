import { redirect } from "next/navigation";

import type { AuthContext } from "@/application/auth-context";
import { listConnections } from "@/application/connections-service";
import { listSpaces } from "@/application/knowledge-service";
import { hasChosenModules, visibleModules } from "@/application/modules-service";
import { NATIVE_MODULES } from "@/core/modules/registry";
import {
  ONBOARDING_STEPS,
  SPACE_PRESETS,
  type OnboardingProgress,
} from "@/features/onboarding/model";

import type { RouteInput } from "../(app)/route-contract";

/**
 * First run (ADR-019). New accounts land here once; anyone can see it again from Settings
 * (`?again=1`). Progress is saved per step, so returning from Google or Notion resumes it.
 * The same loader serves ELISE Desktop (ADR-092).
 */
export async function load(auth: AuthContext, { search: params }: RouteInput) {
  const again = params.again === "1";
  if (auth.profile.onboardingStatus !== "pending" && !again && !params.connected && !params.error)
    redirect("/");

  const [progressRow, connections, spaces, chosen, enabled] = await Promise.all([
    auth.db
      .from("user_preferences")
      .select("value_json")
      .eq("workspace_id", auth.workspaceId)
      .eq("user_id", auth.userId)
      .eq("key", "onboarding.progress")
      .maybeSingle(),
    listConnections(auth).catch(() => null),
    listSpaces(auth).catch(() => []),
    hasChosenModules(auth),
    visibleModules(auth),
  ]);
  // Their own choice when they made one (seeing onboarding again); otherwise a few suggestions,
  // never everything (ADR-064).
  const modules = chosen ? enabled : NATIVE_MODULES.filter((m) => m.suggested).map((m) => m.key);
  const stored = (progressRow.data?.value_json ?? null) as Partial<OnboardingProgress> | null;
  const progress: OnboardingProgress = {
    step:
      params.connected || params.error
        ? "connect"
        : !again && ONBOARDING_STEPS.includes(stored?.step as never)
          ? stored!.step!
          : "welcome",
    spacePreset: SPACE_PRESETS.includes(stored?.spacePreset as never) ? stored!.spacePreset : null,
    spaceId: typeof stored?.spaceId === "string" ? stored.spaceId : null,
  };

  const accounts = (connections?.connections ?? [])
    .filter((c) => c.providerKey !== "elise_native")
    .map((c) => ({
      id: c.id,
      provider: c.providerKey as "google" | "notion",
      label: c.accountLabel ?? c.displayName,
      health: c.health,
      capabilities: c.capabilities.filter((x) => x.enabled && x.granted).map((x) => x.key),
    }));

  return {
    personality: auth.profile.personality,
    initial: progress,
    modules,
    profile: {
      displayName: auth.profile.displayName ?? "",
      language: auth.profile.locale,
      timezone: auth.profile.timezone,
    },
    accounts,
    googleAvailable: connections?.googleAvailable ?? false,
    notionAvailable: connections?.notionAvailable ?? false,
    // The user's own areas; General Knowledge exists already (ADR-047).
    spaces: spaces
      .filter((s) => !s.parentId && !s.general)
      .map((s) => ({ id: s.id, name: s.name, icon: s.icon, color: s.color })),
    returned: {
      connected: typeof params.connected === "string",
      missing: typeof params.missing === "string" ? params.missing.split(",") : [],
      error: typeof params.error === "string" ? params.error : null,
    },
  };
}

export type OnboardingProps = Awaited<ReturnType<typeof load>>;

import { isEnabled } from "@/config/flags";
import { availableVoiceKeys } from "@/infrastructure/ai/voices";

import type { RouteLoader } from "../../route-contract";

export const load = (async (auth) => {
  const v = auth.profile.voice;
  return {
    initial: { continuous: v.continuous, language: v.language, voice: v.voice },
    voices: availableVoiceKeys(),
    wakeAllowed: isEnabled("wakePhrase", auth),
  };
}) satisfies RouteLoader<unknown>;

export type VoiceProps = Awaited<ReturnType<typeof load>>;

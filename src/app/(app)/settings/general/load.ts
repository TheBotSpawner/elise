import type { RouteLoader } from "../../route-contract";

export const load = (async (auth) => ({
  profile: {
    displayName: auth.profile.displayName ?? "",
    language: auth.profile.locale,
    timezone: auth.profile.timezone,
  },
})) satisfies RouteLoader<unknown>;

export type GeneralProps = Awaited<ReturnType<typeof load>>;

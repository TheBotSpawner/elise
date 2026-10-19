import type { RouteLoader } from "../../route-contract";

export const load = (async (auth) => ({
  personality: auth.profile.personality,
})) satisfies RouteLoader<unknown>;

export type PersonalityProps = Awaited<ReturnType<typeof load>>;

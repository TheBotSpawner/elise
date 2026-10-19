import type { RouteLoader } from "../../route-contract";

export const load = (async (auth) => ({
  theme: auth.profile.theme,
  accent: auth.profile.accent,
})) satisfies RouteLoader<unknown>;

export type AppearanceProps = Awaited<ReturnType<typeof load>>;

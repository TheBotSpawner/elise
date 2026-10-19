import type { RouteLoader } from "../../route-contract";

export const load = (async (auth) => {
  const { data } = await auth.db.auth.getUser();
  const user = data.user;
  const providers = [
    ...new Set([
      ...(user?.identities ?? []).map((i) => i.provider),
      ...(typeof user?.app_metadata?.provider === "string" ? [user.app_metadata.provider] : []),
    ]),
  ];
  return { displayName: auth.profile.displayName, email: auth.email, providers };
}) satisfies RouteLoader<unknown>;

export type AccountProps = Awaited<ReturnType<typeof load>>;

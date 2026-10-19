import { headers } from "next/headers";

import { isAdmin } from "@/application/usage-service";
import {
  desktopReleaseFor,
  desktopReleases,
  DESKTOP_PLATFORMS,
  platformFromUserAgent,
  type DesktopPlatform,
} from "@/config/desktop-releases";

import { one, type RouteLoader } from "../../route-contract";

export const load = (async (auth, { search }) => {
  const h = await headers();
  const tester = { tester: isAdmin(auth) };
  const os = one(search.os);
  const chosen =
    os && (DESKTOP_PLATFORMS as readonly string[]).includes(os) ? (os as DesktopPlatform) : null;
  const platform = chosen ?? platformFromUserAgent(h.get("user-agent"));
  const [main, all] = await Promise.all([
    platform ? desktopReleaseFor(platform, tester) : null,
    desktopReleases(tester),
  ]);
  const release = main ?? (platform ? null : (all[0] ?? null));
  // Only builds that exist, never the one this page is already about.
  const others = DESKTOP_PLATFORMS.filter(
    (p) => p !== (release?.platform ?? platform) && all.some((r) => r.platform === p),
  );
  return { release, platform, others, fromHome: search.from === "home" };
}) satisfies RouteLoader<unknown>;

export type DesktopDownloadProps = Awaited<ReturnType<typeof load>>;

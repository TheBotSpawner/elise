import { permanentRedirect } from "next/navigation";

import type { RouteLoader } from "../../route-contract";

/** Shortcuts moved to Settings (ADR-064): old links and bookmarks keep working. */
export const load = (async () =>
  permanentRedirect("/settings/shortcuts")) satisfies RouteLoader<unknown>;

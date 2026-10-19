import { requireAuthContext } from "@/application/auth-context";

import { load } from "./load";
import { View } from "./view";

/**
 * ELISE Desktop (ADR-081/082): the build for this computer first, the others one tap away, and
 * back to Hogar when setup started there. Builds come from the release manifest — the same one
 * the updater follows; with none for this audience the page says so instead of a fake link.
 */
export default async function DesktopDownloadPage({
  searchParams,
}: PageProps<"/download/desktop">) {
  const auth = await requireAuthContext();
  return <View {...await load(auth, { params: {}, search: await searchParams })} />;
}

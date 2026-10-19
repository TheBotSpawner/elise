import { requireAuthContext } from "@/application/auth-context";

import { load } from "./load";
import { View } from "./view";

/**
 * The Connections Hub (ADR-043): providers, searchable, from persisted connection metadata only
 * (no provider is called to draw it). Accounts and capabilities live in each provider's page.
 */
export default async function ConnectionsPage() {
  const auth = await requireAuthContext();
  return <View {...await load(auth)} />;
}

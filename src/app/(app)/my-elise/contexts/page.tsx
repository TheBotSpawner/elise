import { requireAuthContext } from "@/application/auth-context";

import { load } from "./load";
import { View } from "./view";

/**
 * Contexts from before Sections (ADR-018), kept reachable while they aren't a Section yet:
 * creating a Section with the same name adopts one. Not in the navigation.
 */
export default async function ContextsPage() {
  const auth = await requireAuthContext();
  return <View {...await load(auth)} />;
}

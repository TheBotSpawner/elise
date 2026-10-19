import { requireAuthContext } from "@/application/auth-context";

import { load } from "./load";
import { View } from "./view";

export const dynamic = "force-dynamic";

/**
 * Internal performance view (ADR-025): recent turns with their timeline — setup, each model
 * call (profile, reasoning, tokens, cache), each tool — and p50/p90 per intent. Engineering
 * tooling for ELISE_ADMIN_EMAILS only; no content is ever recorded or shown.
 */
export default async function PerfPage() {
  const auth = await requireAuthContext();
  return <View {...await load(auth)} />;
}

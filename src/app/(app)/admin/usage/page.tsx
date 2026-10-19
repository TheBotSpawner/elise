import { requireAuthContext } from "@/application/auth-context";

import { load } from "./load";
import { View } from "./view";

export const dynamic = "force-dynamic";

/**
 * Internal usage view (ADR-019): AI requests, tokens, estimated cost, web queries, voice and
 * background jobs, aggregated. Only for ELISE_ADMIN_EMAILS; everyone else gets a 404. No
 * content and no user identities — this is engineering visibility, not customer billing.
 */
export default async function UsagePage() {
  const auth = await requireAuthContext();
  return <View {...await load(auth)} />;
}

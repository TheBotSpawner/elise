import { requireAuthContext } from "@/application/auth-context";

import { load } from "./load";
import { View } from "./view";

/** Approval Center: pending actions from chat, background work or other devices. */
export default async function ApprovalsPage() {
  const auth = await requireAuthContext();
  return <View {...await load(auth)} />;
}

import { requireAuthContext } from "@/application/auth-context";

import { load } from "./load";
import { View } from "./view";

export default async function AppearanceSettingsPage() {
  const auth = await requireAuthContext();
  return <View {...await load(auth)} />;
}

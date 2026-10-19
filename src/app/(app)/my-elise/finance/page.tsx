import { requireAuthContext } from "@/application/auth-context";

import { load } from "./load";
import { View } from "./view";

export default async function FinancePage({ searchParams }: PageProps<"/my-elise/finance">) {
  const auth = await requireAuthContext();
  return <View {...await load(auth, { params: {}, search: await searchParams })} />;
}

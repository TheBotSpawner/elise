import { requireAuthContext } from "@/application/auth-context";

import { load } from "./load";
import { View } from "./view";

export default async function FinanceImportPage({
  params,
}: PageProps<"/my-elise/finance/import/[id]">) {
  const auth = await requireAuthContext();
  return <View {...await load(auth, { params: await params, search: {} })} />;
}

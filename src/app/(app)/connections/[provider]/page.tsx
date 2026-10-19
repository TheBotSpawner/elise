import { requireAuthContext } from "@/application/auth-context";

import { load } from "./load";
import { View } from "./view";

/** One provider and its accounts (ADR-043): deep-linkable, e.g. /connections/google. */
export default async function ProviderPage({
  params,
  searchParams,
}: PageProps<"/connections/[provider]">) {
  const auth = await requireAuthContext();
  return <View {...await load(auth, { params: await params, search: await searchParams })} />;
}

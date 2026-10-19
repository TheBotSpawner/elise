import { requireAuthContext } from "@/application/auth-context";

import { load } from "./load";
import { View } from "./view";

export default async function SpacePage({
  params,
  searchParams,
}: PageProps<"/knowledge/spaces/[id]">) {
  const auth = await requireAuthContext();
  return <View {...await load(auth, { params: await params, search: await searchParams })} />;
}

import { requireAuthContext } from "@/application/auth-context";

import { load } from "./load";
import { View } from "./view";

/**
 * Source preview for a citation: metadata, the cited passage, versions and a way to the
 * original (signed download for uploads, provider link for Drive/Notion). Not an editor.
 */
export default async function KnowledgeItemPage({
  params,
  searchParams,
}: PageProps<"/knowledge/items/[id]">) {
  const auth = await requireAuthContext();
  return <View {...await load(auth, { params: await params, search: await searchParams })} />;
}

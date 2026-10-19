import { requireAuthContext } from "@/application/auth-context";

import { load } from "./load";
import { View } from "./view";

export default async function ListPage({ params }: PageProps<"/my-elise/lists/[id]">) {
  const auth = await requireAuthContext();
  await load(auth, { params: await params, search: {} });
  return <View />;
}

import { requireAuthContext } from "@/application/auth-context";

import { load } from "./load";
import { View } from "./view";

export default async function NotesPage({ searchParams }: PageProps<"/my-elise/notes">) {
  const auth = await requireAuthContext();
  return <View {...await load(auth, { params: {}, search: await searchParams })} />;
}

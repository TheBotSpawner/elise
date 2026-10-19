import { requireAuthContext } from "@/application/auth-context";

import { load } from "./load";
import { View } from "./view";

/**
 * History (ADR-020): typed and voice conversations, organized by the same Spaces and Sections
 * as Knowledge. By default it reads as folders, Space > Section > conversations, plus the
 * untagged ones; each conversation is filed once under its primary link (other links stay as
 * chips). Search is global and flat, each result showing where it is filed. A flat list and
 * Section groups remain a choice.
 */
export default async function ChatHistoryPage({ searchParams }: PageProps<"/chat">) {
  const auth = await requireAuthContext();
  return <View {...await load(auth, { params: {}, search: await searchParams })} />;
}

import { requireAuthContext } from "@/application/auth-context";
import { ChatSurface } from "@/features/chat/chat-surface";

/** Home is chat-first: the Orb, one input, nothing competing for attention. */
export default async function HomePage() {
  const auth = await requireAuthContext();
  return <ChatSurface timezone={auth.profile.timezone} />;
}

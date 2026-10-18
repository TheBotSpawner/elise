import { requireAuthContext } from "@/application/auth-context";
import { ChatSurface } from "@/features/chat/chat-surface";

import { homePageProps } from "./home-props";

/** Home is chat-first: the Orb, one input, and only real, quiet context. */
export default async function HomePage({ searchParams }: PageProps<"/">) {
  const [auth, params] = await Promise.all([requireAuthContext(), searchParams]);
  const { key, props } = await homePageProps(auth, params);
  return <ChatSurface key={key} {...props} />;
}

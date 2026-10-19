import { redirect } from "next/navigation";

import { getAuthContext } from "@/application/auth-context";

import { load } from "./load";
import { View } from "./view";

export default async function OnboardingPage({ searchParams }: PageProps<"/onboarding">) {
  const auth = await getAuthContext();
  if (!auth) redirect("/login");
  return <View {...await load(auth, { params: {}, search: await searchParams })} />;
}

import type { Metadata } from "next";

import { requireAuthContext } from "@/application/auth-context";

import { load } from "./load";
import { View } from "./view";

export const metadata: Metadata = { title: "Tasks" };

export default async function TasksPage({ searchParams }: PageProps<"/my-elise/tasks">) {
  const auth = await requireAuthContext();
  return <View {...await load(auth, { params: {}, search: await searchParams })} />;
}

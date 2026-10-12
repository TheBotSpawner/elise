import { redirect } from "next/navigation";

/** A list opens as its column on the Lists workspace (ADR-051); old links keep working. */
export default async function ListPage({ params }: PageProps<"/my-elise/lists/[id]">) {
  const { id } = await params;
  redirect(`/my-elise/lists?focus=${encodeURIComponent(id)}`);
}

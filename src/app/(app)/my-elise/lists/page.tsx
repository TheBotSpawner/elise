import { requireAuthContext } from "@/application/auth-context";
import { listsWorkspace } from "@/application/native-service";
import { PageHeader } from "@/components/shared/page";
import { ListsWorkspace } from "@/features/native/lists-workspace";
import { getT } from "@/lib/i18n/server";

export default async function ListsPage({ searchParams }: PageProps<"/my-elise/lists">) {
  const [auth, { t }, params] = await Promise.all([requireAuthContext(), getT(), searchParams]);
  const lists = await listsWorkspace(auth);
  const focus = typeof params.focus === "string" ? params.focus : null;
  return (
    // Wide: lists sit side by side as columns (ADR-051).
    <div className="mx-auto w-full max-w-[1800px] px-4 pt-6 pb-10 md:px-8 md:pt-8">
      <PageHeader title={t.native.lists.title} subtitle={t.native.lists.ws.subtitle} />
      <ListsWorkspace lists={lists} workspaceId={auth.workspaceId} focus={focus} />
    </div>
  );
}

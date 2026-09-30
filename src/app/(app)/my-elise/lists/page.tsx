import { requireAuthContext } from "@/application/auth-context";
import { listsOverview } from "@/application/native-service";
import { PageContainer, PageHeader } from "@/components/shared/page";
import { ListsIndex } from "@/features/native/lists-view";
import { getT } from "@/lib/i18n/server";

export default async function ListsPage() {
  const [auth, { t }] = await Promise.all([requireAuthContext(), getT()]);
  const lists = await listsOverview(auth);
  return (
    <PageContainer>
      <PageHeader title={t.native.lists.title} subtitle={t.native.lists.subtitle} />
      <ListsIndex lists={lists} workspaceId={auth.workspaceId} />
    </PageContainer>
  );
}

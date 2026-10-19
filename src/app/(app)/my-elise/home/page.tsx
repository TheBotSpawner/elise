import { headers } from "next/headers";

import { requireAuthContext } from "@/application/auth-context";
import { MY_ELISE_ICONS } from "@/components/elise/navigation/nav-items";
import { PageContainer, PageHeader } from "@/components/shared/page";
import { HomeView } from "@/features/home/home-view";
import { getT } from "@/lib/i18n/server";

import { homeHubPageProps } from "./props";

export default async function HomePage() {
  const [auth, { t }, h] = await Promise.all([requireAuthContext(), getT(), headers()]);
  const props = await homeHubPageProps(auth, h.get("user-agent"));
  return (
    <PageContainer wide>
      <PageHeader
        title={t.smartHome.title}
        icon={MY_ELISE_ICONS.home}
        info={[t.smartHome.subtitle]}
      />
      <HomeView {...props} />
    </PageContainer>
  );
}

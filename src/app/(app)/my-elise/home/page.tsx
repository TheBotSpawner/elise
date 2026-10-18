import { requireAuthContext } from "@/application/auth-context";
import { homeSnapshot } from "@/application/home-service";
import { MY_ELISE_ICONS } from "@/components/elise/navigation/nav-items";
import { PageContainer, PageHeader } from "@/components/shared/page";
import { AppError } from "@/core/errors";
import type { HomeSnapshot } from "@/core/home/model";
import { HomeView } from "@/features/home/home-view";
import { getT } from "@/lib/i18n/server";

const EMPTY: HomeSnapshot = {
  home: null,
  hub: null,
  rooms: [],
  devices: [],
  groups: [],
  scenes: [],
};

export default async function HomePage() {
  const [auth, { t }] = await Promise.all([requireAuthContext(), getT()]);
  // A database without migration 049 yet: the setup screen, never an error page.
  const snapshot = await homeSnapshot(auth).catch((error) => {
    if (error instanceof AppError && error.code === "CAPABILITY_UNAVAILABLE") return EMPTY;
    throw error;
  });
  return (
    <PageContainer wide>
      <PageHeader
        title={t.smartHome.title}
        icon={MY_ELISE_ICONS.home}
        info={[t.smartHome.subtitle]}
      />
      <HomeView
        snapshot={snapshot}
        workspaceId={auth.workspaceId}
        timezone={auth.profile.timezone}
      />
    </PageContainer>
  );
}

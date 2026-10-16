import { requireAuthContext } from "@/application/auth-context";
import { listConnections } from "@/application/connections-service";
import { spaceOptions } from "@/application/knowledge-service";
import { methodStore } from "@/application/methods-service";
import { listSchedules } from "@/application/schedules-service";
import { SECTION_ICONS } from "@/components/elise/navigation/nav-items";
import { PageContainer, PageHeader } from "@/components/shared/page";
import { scheduleInputSchema, type ScheduleInput } from "@/core/schedules/schedule";
import { SchedulesView } from "@/features/schedules/schedules-view";
import { getT } from "@/lib/i18n/server";

/** A proposal from chat opened for editing arrives as base64url JSON and is re-validated here. */
function parseDraft(value: string | string[] | undefined): ScheduleInput | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = scheduleInputSchema.safeParse(
      JSON.parse(Buffer.from(value, "base64url").toString("utf8")),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export default async function SchedulesPage({ searchParams }: PageProps<"/schedules">) {
  const [auth, { t }, params] = await Promise.all([requireAuthContext(), getT(), searchParams]);
  const [{ schedules, backgroundAvailable }, spaces, methods, connections] = await Promise.all([
    listSchedules(auth),
    spaceOptions(auth).catch(() => []),
    methodStore(auth)
      .index()
      .catch(() => []),
    listConnections(auth).catch(() => null),
  ]);
  // Slack workspaces a brief can read (ADR-062); none connected → the Slack block isn't offered.
  const slackWorkspaces = (connections?.connections ?? [])
    .filter((c) => c.providerKey === "slack" && c.capabilities.some((x) => x.enabled))
    .map((c) => ({ id: c.id, name: c.displayName }));
  return (
    <PageContainer wide>
      <PageHeader
        title={t.schedules.title}
        icon={SECTION_ICONS.schedules}
        info={[t.schedules.subtitle]}
      />
      <SchedulesView
        schedules={schedules}
        workspaceId={auth.workspaceId}
        timezone={auth.profile.timezone}
        spaces={spaces}
        slackWorkspaces={slackWorkspaces}
        methods={methods.map((m) => ({ id: m.id, name: m.name }))}
        backgroundAvailable={backgroundAvailable}
        draft={parseDraft(params.draft)}
      />
    </PageContainer>
  );
}

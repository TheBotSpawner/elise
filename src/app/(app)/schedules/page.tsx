import { requireAuthContext } from "@/application/auth-context";
import { spaceOptions } from "@/application/knowledge-service";
import { listSchedules } from "@/application/schedules-service";
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
  const [{ schedules, backgroundAvailable }, spaces] = await Promise.all([
    listSchedules(auth),
    spaceOptions(auth).catch(() => []),
  ]);
  return (
    <PageContainer>
      <PageHeader title={t.schedules.title} subtitle={t.schedules.subtitle} />
      <SchedulesView
        schedules={schedules}
        workspaceId={auth.workspaceId}
        timezone={auth.profile.timezone}
        spaces={spaces}
        backgroundAvailable={backgroundAvailable}
        draft={parseDraft(params.draft)}
      />
    </PageContainer>
  );
}

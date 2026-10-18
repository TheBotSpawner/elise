import { useEffect, useMemo, useState, type ComponentProps } from "react";

import { MY_ELISE_ICONS } from "@/components/elise/navigation/nav-items";
import { PageContainer, PageHeader } from "@/components/shared/page";
import type { HomeSnapshot, HomeState } from "@/core/home/model";
import type { LocalHomeDevice } from "@/core/platform/platform";
import { ChatSurface } from "@/features/chat/chat-surface";
import { HomeView } from "@/features/home/home-view";
import { useI18n } from "@/lib/i18n/client";

import { useConnectivity, usePageData } from "./data";
import { localHome } from "./local-home";
import { useDesktopRouter } from "./router";
import { NeedsConnection, NotYet, StaleNote } from "./screens";

/** Inicio: exactly the web's Home (same loader, same ChatSurface). */
export function HomeRoute() {
  const { search } = useDesktopRouter();
  const page = usePageData<{ key: string; props: ComponentProps<typeof ChatSurface> }>(
    `/${search}`,
  );
  if (page.status === "loading") return null;
  if (page.status === "offline") return <NeedsConnection onRetry={page.reload} />;
  if (page.status !== "ready") return <NotYet path={`/${search}`} />;
  return (
    <>
      <StaleNote cachedAt={page.cachedAt} />
      <ChatSurface key={page.data.key} {...page.data.props} />
    </>
  );
}

type HogarData = {
  props: ComponentProps<typeof HomeView>;
  providerKeys: Record<string, string>;
};

/**
 * Hogar: the web's screen; with ELISE Cloud unreachable it shows the last-known home with the
 * live states the local runtime reports, and its controls go to the home directly (ADR-081).
 */
export function HogarRoute() {
  const { t } = useI18n();
  const page = usePageData<HogarData>("/my-elise/home");
  const c = useConnectivity();
  const [live, setLive] = useState<LocalHomeDevice[]>([]);
  const [applied, setApplied] = useState<Record<string, HomeState>>({});
  const cloudDown = c.cloud !== "online";

  useEffect(() => {
    localHome.setCloudDown(cloudDown);
    if (!cloudDown || c.home !== "online") return;
    let stop = false;
    const read = () =>
      void window.eliseDesktop!.listLocalHomeDevices().then((d) => !stop && setLive(d));
    read();
    const timer = setInterval(read, 5000);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [cloudDown, c.home]);

  useEffect(
    () =>
      localHome.onApplied((id, state) => setApplied((a) => ({ ...a, [id]: state as HomeState }))),
    [],
  );

  const data = page.status === "ready" ? page.data : null;
  useEffect(() => {
    if (data) localHome.set(data.props.snapshot, data.providerKeys);
  }, [data]);

  const snapshot = useMemo<HomeSnapshot | null>(() => {
    if (!data) return null;
    const s = data.props.snapshot;
    if (!cloudDown) return s;
    const byKey = new Map(live.map((d) => [d.providerKey, d]));
    return {
      ...s,
      // The home itself answers locally, whatever the cloud says.
      hub: s.hub && c.home === "online" ? { ...s.hub, status: "online" } : s.hub,
      devices: s.devices.map((d) => {
        const l = byKey.get(data.providerKeys[d.id] ?? "");
        const state = applied[d.id] ?? (l?.state as HomeState | undefined);
        return state ? { ...d, state, available: l?.available ?? d.available } : d;
      }),
    };
  }, [data, cloudDown, live, applied, c.home]);

  if (page.status === "loading") return null;
  if (page.status === "offline") return <NeedsConnection onRetry={page.reload} />;
  if (!data || !snapshot) return <NotYet path="/my-elise/home" />;
  return (
    <PageContainer wide>
      <PageHeader
        title={t.smartHome.title}
        icon={MY_ELISE_ICONS.home}
        info={[t.smartHome.subtitle]}
      />
      {cloudDown && <StaleNote cachedAt={page.status === "ready" ? page.cachedAt : null} />}
      <HomeView {...data.props} snapshot={snapshot} />
    </PageContainer>
  );
}

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Toaster } from "sonner";

import { AppShell } from "@/components/elise/app-shell";
import type { NavUser } from "@/components/elise/navigation/top-nav";
import { ConfirmProvider } from "@/components/ui/confirm";
import type { DateOrder } from "@/core/dates";
import type { NativeModuleKey } from "@/core/modules/registry";
import {
  DESKTOP_BRIDGE_PROTOCOL_VERSION,
  type HomeHubLocalState,
  type PlatformInfo,
} from "@/core/platform/platform";
import { HomeRuntimeProvider, type HomeRuntimeControls } from "@/features/home/runtime-context";
import { I18nProvider } from "@/lib/i18n/client";
import { PlatformProvider } from "@/lib/platform/platform";
import { applyAppearance } from "@/lib/theme";

import { DesktopStateProvider, usePageData, useSession } from "./data";
import { HogarRoute, HomeRoute } from "./pages";
import { RouterProvider, useDesktopRouter } from "./router";
import {
  CloudBanner,
  DesktopSettings,
  NeedsConnection,
  Notice,
  NotYet,
  OpenInBrowser,
  RecoveryBoundary,
  SignInScreen,
  UpdateRequiredBanner,
} from "./screens";

interface Bootstrap {
  userId: string;
  workspaceId: string;
  onboardingStatus: "pending" | "completed" | "skipped";
  pendingApprovals: number;
  modules: NativeModuleKey[];
  user: NavUser;
  profile: {
    locale: "es" | "en";
    theme: string;
    accent: string;
    dateOrder: DateOrder;
  };
}

const PLATFORM: PlatformInfo = {
  kind: "desktop",
  capabilities: [
    "home_hub",
    "local_runtime",
    "native_notifications",
    "open_external",
    "start_at_login",
    "auto_update",
    "snapshot_cache",
  ],
  bridgeProtocolVersion: DESKTOP_BRIDGE_PROTOCOL_VERSION,
};

const systemLocale = () => (navigator.language.toLowerCase().startsWith("es") ? "es" : "en");

function Routes() {
  const { pathname, search } = useDesktopRouter();
  const screen = (() => {
    if (pathname === "/") return <HomeRoute />;
    if (pathname === "/my-elise/home") return <HogarRoute />;
    if (pathname === "/settings" || pathname === "/settings/desktop") return <DesktopSettings />;
    return <NotYet path={pathname + search} />;
  })();
  return <RecoveryBoundary resetKey={pathname}>{screen}</RecoveryBoundary>;
}

/** The authenticated frame: the web's own AppShell, with the person's settings from the cloud. */
function Frame() {
  const boot = usePageData<Bootstrap>("/__bootstrap");
  const data = boot.status === "ready" ? boot.data : null;
  useEffect(() => {
    if (data) applyAppearance({ theme: data.profile.theme, accent: data.profile.accent });
  }, [data]);

  const locale = data?.profile.locale ?? systemLocale();
  const content = useMemo(() => {
    if (boot.status === "loading") return null;
    if (!data) return <NeedsConnection onRetry={boot.reload} />;
    if (data.onboardingStatus === "pending")
      return <Notice title="ELISE" action={<OpenInBrowser path="/onboarding" />} />;
    return (
      <LocalHomeRuntime>
        <AppShell
          workspaceId={data.workspaceId}
          pendingApprovals={data.pendingApprovals}
          modules={data.modules}
          user={data.user}
        >
          <UpdateRequiredBanner />
          <CloudBanner />
          <Routes />
        </AppShell>
      </LocalHomeRuntime>
    );
  }, [boot, data]);

  return (
    <I18nProvider locale={locale} dateOrder={data?.profile.dateOrder}>
      <ConfirmProvider>{content}</ConfirmProvider>
    </I18nProvider>
  );
}

/** This computer's Home Hub for Hogar (ADR-082): state and actions through the bridge. */
function LocalHomeRuntime({ children }: { children: ReactNode }) {
  const [state, setState] = useState<HomeHubLocalState | null>(null);
  useEffect(() => {
    const b = window.eliseDesktop!;
    void b.getHomeHubState().then(setState);
    return b.onHomeHub(setState);
  }, []);
  const value = useMemo<HomeRuntimeControls>(() => {
    const b = window.eliseDesktop!;
    return {
      state,
      setup: () => b.setupHome(),
      enableRequirements: () => b.enableHomeRequirements(),
      restartComputer: () => b.restartComputer(),
      reset: () => b.resetHome(),
      diagnostics: () => b.homeDiagnostics(),
      discoveries: () => b.listHomeDiscoveries(),
      openDiscovery: (id) => b.openHomeDiscovery(id),
      answerDiscovery: (id, answers) => b.answerHomeDiscovery(id, answers),
      ignoreDiscovery: (id, name) => b.ignoreHomeDiscovery(id, name),
    };
  }, [state]);
  return <HomeRuntimeProvider value={value}>{children}</HomeRuntimeProvider>;
}

function SessionGate() {
  const session = useSession();
  const { navigate } = useDesktopRouter();
  // Deep links and the tray route the window here.
  useEffect(() => window.eliseDesktop!.onNavigate((path) => navigate(path)), [navigate]);
  if (!session) return null;
  return session.signedIn ? (
    <Frame key={`${session.userId}.${session.workspaceId}`} />
  ) : (
    <I18nProvider locale={systemLocale()}>
      <SignInScreen />
    </I18nProvider>
  );
}

export function App() {
  return (
    <PlatformProvider platform={PLATFORM}>
      <RouterProvider>
        <DesktopStateProvider>
          <RecoveryBoundary resetKey="root">
            <SessionGate />
          </RecoveryBoundary>
        </DesktopStateProvider>
      </RouterProvider>
      <Toaster position="top-center" theme="system" richColors closeButton />
    </PlatformProvider>
  );
}

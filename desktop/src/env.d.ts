import type { DesktopBuildConfig } from "../build-config";

declare global {
  /** Injected at build time (public values only). */
  const __ELISE_BUILD__: DesktopBuildConfig;
  const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
  const MAIN_WINDOW_VITE_NAME: string;
}

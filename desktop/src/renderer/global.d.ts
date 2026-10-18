import type { EliseDesktopBridge } from "@/core/platform/platform";

declare global {
  interface Window {
    /** Present only inside ELISE Desktop (preload). */
    eliseDesktop?: EliseDesktopBridge;
  }
}

export {};

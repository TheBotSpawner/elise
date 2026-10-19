import { BrowserWindow, screen } from "electron";

import type { WakeReport } from "@/core/platform/platform";

/**
 * "ELISE" listening in the background (ADR-095): a small orb in the bottom-right corner. It
 * never takes focus or clicks (the active app keeps both), shows only while ELISE's own window
 * isn't the one in use, and glows while ELISE is answering. A static page per state: no
 * scripts, no preload, no bridge.
 */
const SIZE = 36;
const MARGIN = 14;
/** Above an auto-hidden taskbar too (the work area then reaches the screen's edge). */
const BOTTOM = 64;
let orb: BrowserWindow | null = null;
let shown: "listening" | "active" | null = null;

const page = (active: boolean) => {
  const html = `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:transparent;overflow:hidden}
i{position:absolute;inset:${active ? 7 : 9}px;border-radius:50%;
background:radial-gradient(circle at 35% 30%,#bff7fb,#22c5d6 45%,#0b5d6b 100%);
box-shadow:0 0 ${active ? 6 : 4}px rgba(34,197,214,${active ? 0.8 : 0.45});
animation:b ${active ? 0.9 : 3.2}s ease-in-out infinite;opacity:${active ? 1 : 0.55}}
@keyframes b{50%{transform:scale(${active ? 1.12 : 0.88});opacity:${active ? 0.85 : 0.35}}}
@media (prefers-reduced-motion:reduce){i{animation:none}}
</style><i></i>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
};

function create() {
  const { workArea } = screen.getPrimaryDisplay();
  const win = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    useContentSize: true,
    x: workArea.x + workArea.width - SIZE - MARGIN,
    y: workArea.y + workArea.height - SIZE - BOTTOM,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  win.setIgnoreMouseEvents(true);
  win.setAlwaysOnTop(true, "floating");
  win.on("closed", () => {
    orb = null;
    shown = null;
  });
  return win;
}

/** `appInUse`: ELISE's own window is visible and focused (the orb would only repeat it). */
export function updateWakeOrb(status: WakeReport, enabled: boolean, appInUse: boolean) {
  const want =
    !enabled || appInUse
      ? null
      : status === "in_conversation"
        ? "active"
        : status === "listening"
          ? "listening"
          : null;
  if (want === shown) return;
  shown = want;
  if (!want) return orb?.hide();
  orb ??= create();
  void orb.loadURL(page(want === "active")).then(() => {
    // Shown without activation: the app in front keeps its focus.
    if (shown && orb && !orb.isVisible()) orb.showInactive();
  });
}

export function closeWakeOrb() {
  orb?.destroy();
}

import { app } from "electron";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/**
 * Windows installer events (Squirrel.Windows, ADR-082). Squirrel installs per user under
 * %LocalAppData%\elise_desktop (the package id; no admin), runs the app once with one of these
 * flags, and expects it to do its chores and exit quickly. Each version lives in its own
 * app-x.y.z folder; the stub elise_desktop\elise.exe always launches the current one — so the
 * elise:// protocol and start-at-login point at the stub and survive updates.
 */
// Installed by Squirrel, not merely packaged: a build run straight from out\ELISE-win32-x64 has
// no Update.exe above it (and must never point anything at a stub that isn't there).
export const isSquirrelWindows = () =>
  process.platform === "win32" &&
  app.isPackaged &&
  existsSync(resolve(dirname(process.execPath), "..", "Update.exe"));

/**
 * The ELISE people installed (Squirrel on Windows; the app bundle on macOS), as opposed to a
 * local build (desktop/out, `electron .`). Only the installed one may own elise://, start at
 * login and use the real profile: a local build that did so would capture deep links and the
 * single-instance lock, and break the moment it's rebuilt (the black window of 2026-10-19).
 */
export const isInstalledBuild = () =>
  process.platform === "win32" ? isSquirrelWindows() : app.isPackaged;

/** The stable launcher path (never a versioned folder). */
export function stableExe() {
  if (!isSquirrelWindows()) return process.execPath;
  return resolve(dirname(process.execPath), "..", basename(process.execPath));
}

export function handleSquirrelEvent(): boolean {
  if (!isSquirrelWindows()) return false;
  const event = process.argv[1];
  if (!event?.startsWith("--squirrel-")) return false;
  const updateExe = resolve(dirname(process.execPath), "..", "Update.exe");
  const exe = basename(process.execPath);
  const update = (args: string[]) =>
    spawn(updateExe, args, { detached: true, stdio: "ignore" }).on("close", () => app.quit());

  switch (event) {
    case "--squirrel-install":
    case "--squirrel-updated":
      app.setAsDefaultProtocolClient("elise", stableExe());
      update(["--createShortcut", exe]);
      return true;
    case "--squirrel-uninstall": {
      app.removeAsDefaultProtocolClient("elise", stableExe());
      app.setLoginItemSettings({ openAtLogin: false, path: stableExe() });
      // ELISE Home's engine stops; its data stays for a reinstall (removed only on request).
      spawn(
        join(process.env.SystemRoot ?? "C:\\Windows", "System32", "wsl.exe"),
        ["--terminate", "ELISE-Home"],
        {
          detached: true,
          stdio: "ignore",
          windowsHide: true,
        },
      ).on("error", () => undefined);
      update(["--removeShortcut", exe]);
      return true;
    }
    case "--squirrel-obsolete":
      app.quit();
      return true;
    default:
      return false; // --squirrel-firstrun: a normal first launch
  }
}

// ELISE Desktop installer smoke test on Windows (ADR-082). Installs the real Squirrel installer
// silently (per user, no admin), checks what the installer must do, launches the installed app,
// asks ELISE Home to check this computer's requirements (never enabling anything: no admin
// prompt), then uninstalls.
//   node desktop/scripts/installer-smoke.mjs "desktop/out/make/squirrel.windows/x64/ELISE-0.1.0 Setup.exe"
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const setup = process.argv[2];
if (!setup || process.platform !== "win32")
  throw new Error("Usage (Windows): installer-smoke.mjs <Setup.exe>");
const { chromium } = createRequire(new URL("../../package.json", import.meta.url))(
  "@playwright/test",
);
// Squirrel installs under the package id (stable across versions: updates depend on it).
const root = join(process.env.LOCALAPPDATA, "elise_desktop");
const stub = join(root, "elise.exe");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "✓" : "✗"} ${what}`);
  if (!ok) failures.push(what);
};
const killAll = () => {
  try {
    execFileSync("taskkill", ["/IM", "elise.exe", "/F", "/T"], { stdio: "ignore" });
  } catch {}
};
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

try {
  execFileSync(setup, ["--silent"], { stdio: "ignore", timeout: 180_000 });
  for (let i = 0; i < 30 && !existsSync(stub); i++) await wait(1000);
  check(existsSync(stub), `installed per user at ${root} (no admin)`);
  check(existsSync(join(root, "Update.exe")), "uninstaller/updater registered (Update.exe)");
  await wait(4000);
  killAll(); // Squirrel's first run

  let protocol = "";
  try {
    protocol = execFileSync(
      "reg",
      ["query", "HKCU\\Software\\Classes\\elise\\shell\\open\\command", "/ve"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
  } catch {}
  check(
    /elise_desktop\\elise\.exe/i.test(protocol) && !/app-\d/i.test(protocol),
    "elise:// registered to the stable launcher",
  );
  let uninstallKey = "";
  try {
    uninstallKey = execFileSync(
      "reg",
      [
        "query",
        "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\elise_desktop",
        "/v",
        "DisplayName",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
  } catch {}
  check(/ELISE/i.test(uninstallKey), "listed in Windows' installed apps (uninstall entry)");

  const app = spawn(stub, ["--remote-debugging-port=9341"], {
    env,
    stdio: "ignore",
    detached: true,
  });
  app.unref();
  let browser = null;
  for (let i = 0; i < 60 && !browser; i++) {
    browser = await chromium.connectOverCDP("http://127.0.0.1:9341").catch(() => null);
    if (!browser) await wait(500);
  }
  check(Boolean(browser), "installed app launches (no Node, npm or terminal needed)");
  if (browser) {
    let page = null;
    for (let i = 0; i < 40 && !page; i++) {
      page =
        browser
          .contexts()[0]
          .pages()
          .find((p) => p.url().startsWith("elise-app://")) ?? null;
      if (!page) await wait(500);
    }
    const info = await page.evaluate(() => window.eliseDesktop.getDesktopInfo());
    check(
      Boolean(info.desktopVersion),
      `Desktop ${info.desktopVersion} (bridge ${info.bridgeProtocolVersion})`,
    );
    // ELISE Home: check this computer (the elevated "enable" step is never triggered here).
    await page.evaluate(() => window.eliseDesktop.setupHome());
    let home = null;
    for (let i = 0; i < 60; i++) {
      home = await page.evaluate(() => window.eliseDesktop.getHomeHubState());
      if (home && !["checking_requirements", "not_installed"].includes(home.runtime.phase)) break;
      await wait(1000);
    }
    const reqs = home?.runtime.requirements ?? [];
    check(
      reqs.length === 6,
      `requirements checked: ${reqs.map((r) => `${r.key}=${r.ok ? "ok" : "missing"}`).join(", ")}`,
    );
    console.log(
      `  ELISE Home phase: ${home?.runtime.phase} ${home?.runtime.error ? `(${home.runtime.error.code})` : ""}`,
    );
    await browser.close().catch(() => undefined);
  }
} catch (error) {
  failures.push(error.message);
  console.log(`✗ ${error.message}`);
} finally {
  killAll();
  await wait(1500);
  if (existsSync(join(root, "Update.exe"))) {
    try {
      execFileSync(join(root, "Update.exe"), ["--uninstall", "-s"], {
        stdio: "ignore",
        timeout: 120_000,
      });
    } catch {}
    for (let i = 0; i < 30 && existsSync(stub); i++) await wait(1000);
  }
  check(!existsSync(stub), "uninstalls cleanly");
  let left = "";
  try {
    left = execFileSync("reg", ["query", "HKCU\\Software\\Classes\\elise"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {}
  check(!left, "elise:// unregistered on uninstall");
}
process.exit(failures.length ? 1 : 0);

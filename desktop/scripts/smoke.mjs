// ELISE Desktop package smoke test (ADR-081). Runs the packaged app with ELISE Cloud unreachable
// and checks the promises that matter most:
//   1. it boots from local assets — no remote request is needed to render;
//   2. the page gets the typed bridge and nothing of Node;
//   3. a second launch hands over to the first instance and exits (one local runtime);
//   4. a crashed renderer comes back by itself and the local runtime keeps running;
//   5. a cold start from a link (elise://home/setup, the web's "Abrir ELISE Desktop") opens
//      that page — it once hung with no window when started this way.
// Usage: node desktop/scripts/smoke.mjs <path-to-packaged-executable>
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const exe = process.argv[2];
if (!exe) throw new Error("Usage: node desktop/scripts/smoke.mjs <executable>");
const { chromium } = createRequire(new URL("../../package.json", import.meta.url))(
  "@playwright/test",
);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "✓" : "✗"} ${what}`);
  if (!ok) failures.push(what);
};

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const app = spawn(exe, ["--remote-debugging-port=9339"], { env, stdio: "ignore" });
let browser;
try {
  for (let i = 0; i < 60 && !browser; i++) {
    browser = await chromium.connectOverCDP("http://127.0.0.1:9339").catch(() => null);
    if (!browser) await wait(500);
  }
  if (!browser) throw new Error("ELISE Desktop didn't start");
  const ctx = browser.contexts()[0];
  let page;
  for (let i = 0; i < 40 && !page; i++) {
    page = ctx.pages().find((p) => p.url().startsWith("elise-app://"));
    if (!page) await wait(500);
  }
  const remote = [];
  page.on("request", (r) => !r.url().startsWith("elise-app://") && remote.push(r.url()));
  await page.reload();
  await page.waitForSelector("main, [role=alert], nav", { timeout: 20_000 });

  check(remote.length === 0, `boots with no remote requests (${remote.join(", ") || "none"})`);
  const surface = await page.evaluate(() => ({
    bridge: typeof window.eliseDesktop,
    frozen: Object.isFrozen(window.eliseDesktop),
    require: typeof window.require,
    process: typeof window.process,
    ipc: "ipcRenderer" in window,
  }));
  check(
    surface.bridge === "object" &&
      surface.frozen &&
      surface.require === "undefined" &&
      surface.process === "undefined" &&
      !surface.ipc,
    "typed, frozen bridge; no Node APIs in the page",
  );
  const info = await page.evaluate(() => window.eliseDesktop.getDesktopInfo());
  check(
    info.bridgeProtocolVersion >= 1 && info.capabilities.includes("home_hub"),
    "protocol and capabilities reported",
  );

  // A second launch exits on its own (single instance).
  const second = spawn(exe, [], { env, stdio: "ignore" });
  const code = await Promise.race([
    new Promise((r) => second.on("exit", r)),
    wait(15_000).then(() => "timeout"),
  ]);
  check(code !== "timeout", "a second launch hands over and exits");
  if (code === "timeout") second.kill();

  // Renderer crash → it reloads; the local runtime never stopped.
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Page.crash").catch(() => undefined);
  let alive = null;
  for (let i = 0; i < 20 && !alive; i++) {
    await wait(1000);
    // The crashed page object is gone: look again through a fresh connection.
    const fresh = await chromium.connectOverCDP("http://127.0.0.1:9339").catch(() => null);
    const back = fresh
      ?.contexts()[0]
      ?.pages()
      .find((p) => p.url().startsWith("elise-app://"));
    alive = back
      ? await back.evaluate(() => window.eliseDesktop.getConnectivity()).catch(() => null)
      : null;
    await fresh?.close().catch(() => undefined);
  }
  check(alive?.localRuntime === "online", "renderer recovers; local runtime kept running");
} catch (error) {
  failures.push(error.message);
  console.log(`✗ ${error.message}`);
} finally {
  await browser?.close().catch(() => undefined);
  app.kill();
}

// Cold start from a link: no instance running, the link is the only argument (+ a debug port).
await wait(3000);
const linked = spawn(exe, ["--remote-debugging-port=9339", "elise://home/setup"], {
  env,
  stdio: "ignore",
});
let linkedBrowser;
try {
  let url = "";
  for (let i = 0; i < 60 && !url.endsWith("/my-elise/home"); i++) {
    await wait(500);
    linkedBrowser ??= await chromium.connectOverCDP("http://127.0.0.1:9339").catch(() => null);
    url =
      linkedBrowser
        ?.contexts()[0]
        ?.pages()
        .find((p) => p.url().startsWith("elise-app://"))
        ?.url() ?? "";
  }
  check(url.endsWith("/my-elise/home"), "cold start from elise://home/setup opens Hogar");
} catch (error) {
  failures.push(error.message);
  console.log(`✗ ${error.message}`);
} finally {
  await linkedBrowser?.close().catch(() => undefined);
  linked.kill();
}
process.exit(failures.length ? 1 : 0);

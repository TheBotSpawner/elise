import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import tailwind from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

import { actionKey, actionNames } from "./actions-stub";
import { desktopBuildConfig, REPO_ROOT, SRC } from "./build-config";
import { overrideKey } from "./override-key";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const RENDERER = here("./src/renderer");
const posix = (p: string) => p.replaceAll("\\", "/");

const isUseServer = (code: string) => /^\s*(?:\/\/[^\n]*\n\s*)*["']use server["']/.test(code);

function stubFor(file: string, code: string) {
  const key = actionKey(file);
  const rpc = posix(`${RENDERER}/rpc.ts`);
  return [
    `import { callAction } from ${JSON.stringify(rpc)};`,
    ...actionNames(code).map(
      (n) =>
        `export const ${n} = (...args) => callAction(${JSON.stringify(key)}, ${JSON.stringify(n)}, args);`,
    ),
  ].join("\n");
}

/**
 * The same ELISE source, compiled for Desktop's local renderer (ADR-081):
 * - Server Actions become typed RPC calls to ELISE Cloud (what Next does for the web, by name);
 * - next/link and next/navigation map to Desktop's local router;
 * - a few modules get a Desktop variant (local Home control, Supabase with a short-lived token);
 * - anything server-only reaching the renderer fails the build: no secrets can leak into it.
 */
function eliseDesktop(): Plugin {
  const overrides: Record<string, string> = {
    "next/link": `${RENDERER}/shims/next-link.tsx`,
    "next/navigation": `${RENDERER}/shims/next-navigation.ts`,
    "@/infrastructure/supabase/client": `${RENDERER}/overrides/supabase-client.ts`,
    "@/features/home/actions": `${RENDERER}/overrides/home-actions.ts`,
    // Sign-out ends Desktop's own session; sign-in is the browser's (ADR-084).
    "@/features/auth/actions": `${RENDERER}/overrides/auth-actions.ts`,
  };
  return {
    name: "elise-desktop",
    enforce: "pre",
    async resolveId(source, importer, options) {
      if (source === "server-only" || source === "next/headers" || source === "next/cache") {
        // Vite's dependency scan reads action modules raw (before the stubs): skip them there.
        if ((options as { scan?: boolean }).scan) return { id: source, external: true };
        throw new Error(`Server-only module "${source}" imported by ${importer} in the renderer`);
      }
      // The override itself imports the real stub.
      if (source.startsWith("rpc-stub:"))
        return `\0rpc-stub:${posix(`${SRC}/${source.slice(9)}.ts`)}`;
      const key = overrideKey(source, importer, SRC);
      const target = overrides[key];
      if (target && !posix(importer ?? "").startsWith(posix(`${RENDERER}/overrides`)))
        return target;
      return null;
    },
    load(id) {
      if (id.startsWith("\0rpc-stub:")) {
        const file = id.slice(10);
        return stubFor(file, readFileSync(file, "utf8"));
      }
      const file = id.split("?")[0]!;
      if (!/\.(t|j)sx?$/.test(file) || !posix(file).startsWith(posix(SRC))) return null;
      const code = readFileSync(file, "utf8");
      return isUseServer(code) ? stubFor(file, code) : null;
    },
  };
}

/**
 * The wake word's recognizer (ADR-095): Vosk's WebAssembly worker, taken from the vosk-browser
 * package (which embeds it) and shipped as its own file, /vosk-worker.js. Its Emscripten
 * bindings build functions with `new Function`, so the app protocol gives that one response a
 * CSP allowing eval inside it only — a worker has no DOM, no cookies and no session; it gets
 * audio and returns words. The page keeps its strict policy and talks to it with a few messages
 * (src/renderer/wake/vosk-worker-client.ts); the package's page code is never imported.
 */
export const VOSK_WORKER_PATH = "/vosk-worker.js";
let voskWorkerCode = "";
function voskWorker() {
  if (voskWorkerCode) return voskWorkerCode;
  const code = readFileSync(here("./node_modules/vosk-browser/dist/vosk.js"), "utf8");
  const marker = "createBase64WorkerFactory('";
  const start = code.indexOf(marker) + marker.length;
  if (start < marker.length) throw new Error("vosk-browser changed: its worker isn't embedded");
  voskWorkerCode = Buffer.from(code.slice(start, code.indexOf("'", start)), "base64").toString();
  return voskWorkerCode;
}
/** Build: ship the worker file; development: serve it from Vite. */
function voskWorkerFile(): Plugin {
  return {
    name: "elise-vosk-worker",
    configureServer(server) {
      server.middlewares.use(VOSK_WORKER_PATH, (_req, res) => {
        res.setHeader("content-type", "text/javascript; charset=utf-8");
        res.end(voskWorker());
      });
    },
    generateBundle() {
      this.emitFile({ type: "asset", fileName: VOSK_WORKER_PATH.slice(1), source: voskWorker() });
    },
  };
}

export default defineConfig(({ mode }) => {
  const build = desktopBuildConfig(mode);
  return {
    root: RENDERER,
    // Served from elise-app://app/ (history routing): assets are absolute.
    base: "/",
    publicDir: here("../public"),
    build: {
      outDir: here("./.vite/renderer/main_window"),
      emptyOutDir: true,
      target: "chrome140",
      // Loaded from disk, not the network: one bundle is fine.
      chunkSizeWarningLimit: 4000,
    },
    plugins: [voskWorkerFile(), eliseDesktop(), react()],
    // Tailwind sees the whole shared source, exactly like the web build.
    css: { postcss: { plugins: [tailwind({ base: REPO_ROOT })] } },
    // The page lives at elise-app://app; HMR talks to the dev server directly.
    server: {
      port: 5183,
      strictPort: true,
      hmr: { protocol: "ws", host: "localhost", clientPort: 5183 },
    },
    resolve: {
      // One React, the web's own (Forge's tooling brings another copy into desktop/node_modules).
      alias: [
        { find: "@", replacement: SRC },
        ...["react", "react-dom", "scheduler"].map((pkg) => ({
          find: new RegExp(`^${pkg}(/.*)?$`),
          replacement: `${posix(REPO_ROOT)}node_modules/${pkg}$1`,
        })),
      ],
    },
    define: {
      __ELISE_BUILD__: JSON.stringify(build),
      "process.env.NEXT_PUBLIC_SUPABASE_URL": JSON.stringify(build.supabaseUrl),
      "process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY": JSON.stringify(
        build.supabasePublishableKey,
      ),
      "process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY": JSON.stringify(build.googleMapsKey),
      "process.env.NEXT_PUBLIC_APP_URL": JSON.stringify(build.cloudUrl),
      "process.env.NODE_ENV": JSON.stringify(mode === "production" ? "production" : "development"),
      "process.env": "{}",
    },
  };
});

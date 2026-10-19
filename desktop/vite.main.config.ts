import { readFileSync } from "node:fs";

import { defineConfig } from "vite";

import { desktopBuildConfig, SRC } from "./build-config";

const version = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
).version;

// Main process and local runtime: Node targets, shared ELISE core bundled in.
export default defineConfig(({ mode }) => {
  const build = desktopBuildConfig(mode);
  return {
    resolve: { alias: { "@": SRC } },
    define: { __ELISE_BUILD__: JSON.stringify(build) },
    plugins: [
      {
        // What this build talks to, for release checks (public values only).
        name: "elise-build-info",
        generateBundle() {
          this.emitFile({
            type: "asset",
            fileName: "build-info.json",
            source: JSON.stringify(
              {
                version,
                mode,
                cloudUrl: build.cloudUrl,
                channel: build.channel,
                updateFeed: build.updateFeed,
              },
              null,
              2,
            ),
          });
        },
      },
    ],
  };
});

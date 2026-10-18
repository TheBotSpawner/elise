import { defineConfig } from "vite";

import { desktopBuildConfig, SRC } from "./build-config";

// Main process and local runtime: Node targets, shared ELISE core bundled in.
export default defineConfig(({ mode }) => ({
  resolve: { alias: { "@": SRC } },
  define: { __ELISE_BUILD__: JSON.stringify(desktopBuildConfig(mode)) },
}));

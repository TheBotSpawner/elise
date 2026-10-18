import { defineConfig } from "vite";

import { SRC } from "./build-config";

// The preload runs sandboxed: a single CommonJS file, no Node APIs beyond what Electron allows.
export default defineConfig({ resolve: { alias: { "@": SRC } } });

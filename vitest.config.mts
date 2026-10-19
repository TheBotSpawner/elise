import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Desktop's renderer has its own node_modules: one React for every test.
    dedupe: ["react", "react-dom"],
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // Next.js enforces server-only at build time; in unit tests it is a no-op.
      "server-only": fileURLToPath(new URL("./tests/fixtures/server-only.ts", import.meta.url)),
      // ELISE Desktop's main-process code is tested outside Electron (ADR-081).
      electron: fileURLToPath(new URL("./tests/fixtures/electron.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.test.{ts,tsx}", "src/**/*.test.{ts,tsx}"],
  },
});

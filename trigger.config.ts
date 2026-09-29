import { defineConfig } from "@trigger.dev/sdk";

/**
 * Trigger.dev executes ELISE's background work (docs/architecture/14). Tasks in src/trigger are
 * thin entry points into application services. The project ref is not a secret; the secret key
 * only lives in the environment (TRIGGER_SECRET_KEY).
 */
export default defineConfig({
  project: process.env.TRIGGER_PROJECT_REF ?? "proj_qmikwkyefwqjpkftymul",
  dirs: ["./src/trigger"],
  maxDuration: 300,
  retries: {
    enabledInDev: true,
    default: { maxAttempts: 3, factor: 2, minTimeoutInMs: 5_000, maxTimeoutInMs: 60_000 },
  },
  build: {
    // Server modules import "server-only"; this condition resolves it to its no-op build.
    conditions: ["react-server"],
  },
});

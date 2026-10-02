import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests (ADR-019, docs/engineering/20-testing-acceptance.md).
 * - e2e/public.spec.ts needs only the app (no accounts, no providers): it runs everywhere.
 * - e2e/journeys.spec.ts also needs a Supabase project with the migrations applied and its
 *   secret key (NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
 *   SUPABASE_SECRET_KEY). It creates a throwaway user and deletes it afterwards. External
 *   providers and the model are mocked at the browser boundary; nothing calls Google, Notion
 *   or OpenAI.
 * Run: `npm run build && npm run test:e2e` (the server is started for you).
 */
// Local runs read the same .env.local as `next start`; CI passes variables directly.
try {
  process.loadEnvFile(".env.local");
} catch {
  // No local env file.
}

const PORT = Number(process.env.E2E_PORT ?? 3000);

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
    // Real Chrome (E2E_CHANNEL=chrome) exercises the same engine users run. Playwright's bundled
    // Chromium crashes on SpeechRecognition.available() (the wake-phrase check), so Settings
    // can only be swept on real Chrome.
    ...(process.env.E2E_CHANNEL ? { channel: process.env.E2E_CHANNEL } : {}),
    locale: "es-AR",
    timezoneId: "America/Argentina/Buenos_Aires",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
  webServer: {
    command: `npm run start -- --port ${PORT}`,
    url: `http://localhost:${PORT}/api/health`,
    // 503 (no database) still means the server is up for the public checks.
    ignoreHTTPSErrors: true,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});

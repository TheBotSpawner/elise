import { expect, test } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

/**
 * Product audit sweep (ADR-019 QA matrix): every main screen, signed in, in light and dark,
 * on the project's viewport (desktop and mobile). Each must render without horizontal scroll,
 * uncaught errors or technical error text, with a themed background. Screenshots land in
 * test-results/ for review.
 */
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
test.skip(!url || !secret, "Needs a Supabase project");
test.skip(
  process.env.E2E_CHANNEL !== "chrome",
  "Settings checks wake-phrase support, which crashes Playwright's bundled Chromium: run with E2E_CHANNEL=chrome",
);
test.describe.configure({ mode: "serial" });

const admin = url && secret ? createClient(url, secret, { auth: { persistSession: false } }) : null;
const password = `E2e-${crypto.randomUUID()}`;
let email = "";
let userId = "";

test.beforeAll(async ({}, info) => {
  email = `e2e+audit-${info.project.name}-${Date.now()}@elise.test`;
  const { data, error } = await admin!.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: "QA", preferred_language: "es" },
  });
  if (error) throw error;
  userId = data.user.id;
  // An onboarded account: the sweep is about the product screens.
  await admin!.from("user_profiles").update({ onboarding_status: "completed" }).eq("id", userId);
});

test.afterAll(async () => {
  if (!userId) return;
  await admin!.from("workspaces").delete().eq("owner_user_id", userId).eq("type", "personal");
  await admin!.auth.admin.deleteUser(userId);
});

const ROUTES = (process.env.AUDIT_ROUTES?.split(",") ?? null) || [
  "/",
  "/chat",
  "/knowledge",
  "/connections",
  "/schedules",
  "/my-elise",
  "/my-elise/tasks",
  "/my-elise/habits",
  "/my-elise/lists",
  "/my-elise/goals",
  "/my-elise/notes",
  "/my-elise/finance",
  "/my-elise/shortcuts",
  "/approvals",
  "/settings",
];

/** Text that must never reach a user. */
const TECHNICAL =
  /PGRST\d|OAuthScope|invalid_grant|Trigger task|RPC error|TypeError|undefined is not|\[object Object\]/;

for (const scheme of ["light", "dark"] as const)
  test(`main screens render cleanly (${scheme})`, async ({ page }, info) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(`${page.url()}: ${e.message}`));
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto("/login");
    await page.getByLabel("Email").first().fill(email);
    await page.getByLabel("Contraseña").fill(password);
    await page.getByRole("button", { name: "Ingresar", exact: true }).click();
    await page.waitForURL((u) => !u.pathname.startsWith("/login"));

    for (const route of ROUTES) {
      console.log(`audit ${scheme} ${info.project.name} ${route}`);
      await page.goto(route);
      await page.waitForLoadState("networkidle").catch(() => undefined);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `${route} scrolls sideways by ${overflow}px`).toBeLessThanOrEqual(1);
      const text = await page.locator("body").innerText();
      expect(text, `${route} shows technical text`).not.toMatch(TECHNICAL);
      const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      expect(bg, `${route} has no background`).not.toBe("rgba(0, 0, 0, 0)");
      await page.screenshot({
        path: info.outputPath(`${scheme}${route.replaceAll("/", "_") || "_home"}.png`),
        fullPage: false,
      });
    }
    expect(errors).toEqual([]);
  });

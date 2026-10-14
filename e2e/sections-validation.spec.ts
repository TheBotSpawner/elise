import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

/**
 * Real-browser check of the main sections' headers: icon + title + ⓘ (no subtitle), the info
 * popup over a blurred page, and the system Space named "General".
 *
 *   E2E_REAL=1 E2E_CHANNEL=chrome npx playwright test sections-validation --project=desktop
 */
const real = process.env.E2E_REAL === "1";
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
test.skip(!real || !url || !secret, "On demand: E2E_REAL=1 and Supabase");
test.describe.configure({ mode: "serial", timeout: 180_000 });

const admin = url && secret ? createClient(url, secret, { auth: { persistSession: false } }) : null;
const password = `E2e-${crypto.randomUUID()}`;
let email = "";
let userId = "";
let workspaceId = "";
const report: Record<string, unknown> = {};

test.beforeAll(async ({}, info) => {
  email = `e2e+sections-${info.project.name}-${Date.now()}@elise.test`;
  const { data, error } = await admin!.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: "Validación", preferred_language: "es" },
  });
  if (error) throw error;
  userId = data.user.id;
});

test.afterAll(async () => {
  console.log(`VALIDATION ${JSON.stringify(report, null, 1)}`);
  if (!userId) return;
  if (workspaceId) await admin!.from("workspaces").delete().eq("id", workspaceId);
  await admin!.auth.admin.deleteUser(userId);
});

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").first().fill(email);
  await page.getByLabel("Contraseña").fill(password);
  await page.getByRole("button", { name: "Ingresar", exact: true }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));
}

const SECTIONS = [
  ["/knowledge", "Conocimiento", /Lo que ELISE entiende de tus documentos/],
  ["/connections", "Conexiones", /A qué puede acceder ELISE/],
  ["/schedules", "Programados", /Lo que ELISE prepara por su cuenta/],
  ["/chat", "Historial", /Tus conversaciones anteriores/],
] as const;

async function check(page: Page, theme: string, info: { outputPath: (n: string) => string }) {
  for (const [path, title, text] of SECTIONS) {
    await page.goto(path);
    const h1 = page.getByRole("heading", { level: 1, name: title });
    await expect(h1).toBeVisible();
    expect(await h1.locator("svg").count()).toBe(1);
    // The description is no longer under the title…
    await expect(page.getByText(text)).toHaveCount(0);
    // …it is behind the ⓘ, in a popup.
    await page.getByRole("button", { name: `Qué es ${title}` }).click();
    const dialog = page.getByRole("dialog", { name: title });
    await expect(dialog.getByText(text)).toBeVisible();
    await expect(dialog).toHaveCSS("opacity", "1");
    await page.screenshot({ path: info.outputPath(`${theme}-${path.slice(1)}-info.png`) });
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  }
}

test("setup", async ({ page }) => {
  await signIn(page);
  await expect
    .poll(
      async () => (await admin!.from("user_profiles").select("id").eq("id", userId)).data?.length,
      {
        timeout: 30_000,
      },
    )
    .toBe(1);
  await admin!.from("user_profiles").update({ onboarding_status: "skipped" }).eq("id", userId);
  const { data: ws } = await admin!
    .from("workspaces")
    .select("id")
    .eq("owner_user_id", userId)
    .single();
  workspaceId = ws!.id;
});

test("headers with icon and ⓘ; the system Space is “General”", async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await check(page, "light", info);
  await page.goto("/knowledge");
  await expect(page.getByText("General", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("General Knowledge", { exact: true })).toHaveCount(0);
  await expect(page.getByText(/Los Espacios le dan contexto a ELISE/)).toHaveCount(0);
  const { data } = await admin!
    .from("knowledge_spaces")
    .select("name")
    .eq("workspace_id", workspaceId)
    .eq("kind", "general")
    .single();
  report.generalName = data?.name;
  expect(data?.name).toBe("General");
  await page.screenshot({ path: info.outputPath("light-knowledge.png"), fullPage: true });
});

test("dark mode and mobile", async ({ page }, info) => {
  await admin!.from("user_profiles").update({ theme: "dark" }).eq("id", userId);
  await page.emulateMedia({ colorScheme: "dark" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await check(page, "dark", info);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/knowledge");
  await page.getByRole("button", { name: "Qué es Conocimiento" }).click();
  report.mobileOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  await page.screenshot({ path: info.outputPath("dark-mobile-info.png") });
});

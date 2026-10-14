import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

/**
 * Real-browser check of Microsoft / Outlook in Connections (ADR-058) without a Microsoft account:
 * the Hub finds it, Provider Detail explains it, Connect starts a correct authorization (or says
 * the database needs its update), and callback failures say precisely why.
 * The server needs MICROSOFT_OAUTH_CLIENT_ID / _SECRET (dummy values are enough).
 *
 *   E2E_REAL=1 E2E_CHANNEL=chrome npx playwright test microsoft-validation --project=desktop
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
  email = `e2e+microsoft-${info.project.name}-${Date.now()}@elise.test`;
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

test("setup", async ({ page }) => {
  await signIn(page);
  await expect
    .poll(
      async () => (await admin!.from("user_profiles").select("id").eq("id", userId)).data?.length,
      { timeout: 30_000 },
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

test("the Hub finds Outlook; Provider Detail explains it; Connect starts Microsoft consent", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await page.goto("/connections");
  await page.getByLabel("Buscar conexiones").fill("outlook");
  const card = page.getByRole("link", { name: /^Microsoft:/ });
  await expect(card).toBeVisible();
  await page.screenshot({ path: info.outputPath("hub-outlook.png") });
  await card.click();
  await page.waitForURL("**/connections/microsoft");
  await expect(page.getByRole("heading", { level: 1, name: "Microsoft" })).toBeVisible();
  await expect(page.getByText(/correo de Outlook de una o varias cuentas/)).toBeVisible();

  await page.getByRole("button", { name: "Conectar" }).click();
  const dialog = page.getByRole("dialog", { name: "Conectar cuenta de Microsoft" });
  await expect(dialog.getByText(/enviar en tu nombre/)).toBeVisible();
  await expect(dialog).toHaveCSS("opacity", "1");
  await page.screenshot({ path: info.outputPath("connect-dialog-light.png") });

  const { data: provider } = await admin!
    .from("provider_definitions")
    .select("key")
    .eq("key", "microsoft")
    .maybeSingle();
  report.migration045 = Boolean(provider);

  if (provider) {
    // Stop at Microsoft's door: inspect the authorization request, never sign in.
    const authorize = page.waitForRequest((r) =>
      r.url().startsWith("https://login.microsoftonline.com/"),
    );
    await page.route("https://login.microsoftonline.com/**", (route) =>
      route.fulfill({ status: 200, body: "stopped" }),
    );
    await dialog.getByRole("button", { name: "Continuar con Microsoft" }).click();
    const u = new URL((await authorize).url());
    report.authorize = `${u.origin}${u.pathname}`;
    expect(u.pathname).toBe("/common/oauth2/v2.0/authorize");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("code_challenge")).toBeTruthy();
    expect(u.searchParams.get("state")).toBeTruthy();
    expect(u.searchParams.get("prompt")).toBe("select_account");
    expect(u.searchParams.get("redirect_uri")).toMatch(/\/api\/connections\/microsoft\/callback$/);
    expect(u.searchParams.get("scope")).toBe(
      "openid profile offline_access User.Read Mail.ReadWrite Mail.Send",
    );
    expect(u.toString()).not.toMatch(/client_secret/i);
    // The pending authorization exists server-side, bound to this user.
    const { data: states } = await admin!
      .from("oauth_states")
      .select("provider_key, capabilities")
      .eq("user_id", userId);
    expect(states).toEqual([{ provider_key: "microsoft", capabilities: ["email"] }]);
  } else {
    // Without migration 045 the start fails clearly instead of breaking the page.
    await dialog.getByRole("button", { name: "Continuar con Microsoft" }).click();
    await expect(
      page.getByText("ELISE todavía no está configurada del todo en el servidor para esto."),
    ).toBeVisible();
    report.startWithoutMigration = "SERVER_NOT_CONFIGURED toast";
  }
});

test("callback failures say precisely why, and a forged callback completes nothing", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await page.goto(
    "/connections?provider=microsoft&error=PERMISSION_DENIED&reason=admin_consent_required",
  );
  await expect(page.getByText(/requiere que un administrador apruebe ELISE/)).toBeVisible();
  await page.screenshot({ path: info.outputPath("admin-consent-toast.png") });

  // A callback with a state nobody issued: nothing is connected, the user is told.
  await page.goto("/api/connections/microsoft/callback?code=forged&state=not-a-real-state");
  await page.waitForURL((u) => u.pathname === "/connections");
  await expect(page.getByText("Eso ya se resolvió o cambió mientras tanto.")).toBeVisible();
  const { data: conns } = await admin!
    .from("provider_connections")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("provider_key", "microsoft");
  expect(conns ?? []).toHaveLength(0);
});

test("dark mode and mobile", async ({ page }, info) => {
  await admin!.from("user_profiles").update({ theme: "dark" }).eq("id", userId);
  await page.emulateMedia({ colorScheme: "dark" });
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await page.goto("/connections/microsoft");
  await page.getByRole("button", { name: "Conectar" }).click();
  const dialog = page.getByRole("dialog", { name: "Conectar cuenta de Microsoft" });
  await expect(dialog).toHaveCSS("opacity", "1");
  report.mobileOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(report.mobileOverflow).toBe(0);
  await page.screenshot({ path: info.outputPath("connect-dialog-dark-mobile.png") });
});

import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

/**
 * Real-browser check of the Methods editor and ELISE's single contextual-help pattern:
 * - saving a Method closes the editor and the card appears at once;
 * - "Material de apoyo" starts collapsed;
 * - every ⓘ (General, Conexiones, Mi ELISE sections…) is an anchored card, never a modal over a
 *   blurred page, and stays inside the viewport (desktop and phone).
 *
 *   E2E_REAL=1 E2E_CHANNEL=chrome E2E_PORT=3100 npx playwright test methods-help-validation
 */
const real = process.env.E2E_REAL === "1";
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
test.skip(!real || !url || !secret, "On demand: E2E_REAL=1 and Supabase");
test.describe.configure({ mode: "serial", timeout: 240_000 });

const admin = url && secret ? createClient(url, secret, { auth: { persistSession: false } }) : null;
const password = `E2e-${crypto.randomUUID()}`;
let email = "";
let userId = "";
let workspaceId = "";
let general = "";
const report: Record<string, unknown> = {};

test.beforeAll(async ({}, info) => {
  email = `e2e+help-${info.project.name}-${Date.now()}@elise.test`;
  const { data, error } = await admin!.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: "Leo", preferred_language: "es" },
  });
  if (error) throw error;
  userId = data.user.id;
});

test.afterAll(async () => {
  console.log(`VALIDATION ${JSON.stringify(report, null, 1)}`);
  if (!userId) return;
  if (workspaceId) {
    await admin!.from("methods").delete().eq("workspace_id", workspaceId);
    await admin!.from("workspaces").delete().eq("id", workspaceId);
  }
  await admin!.auth.admin.deleteUser(userId);
});

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").first().fill(email);
  await page.getByLabel("Contraseña").fill(password);
  await page.getByRole("button", { name: "Ingresar", exact: true }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));
}

/** Opens an ⓘ by click: an anchored card inside the viewport, no dialog, no overlay. */
async function help(page: Page, label: string | RegExp) {
  await page.getByRole("button", { name: label }).first().click();
  const tip = page.getByRole("tooltip");
  await expect(tip).toBeVisible();
  const box = (await tip.boundingBox())!;
  const vp = page.viewportSize()!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(vp.width);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(vp.height);
  // No modal and no full-page overlay: the page stays usable around the card.
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  const text = await tip.innerText();
  return { text, tip };
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
  await expect
    .poll(
      async () =>
        (
          await admin!
            .from("knowledge_spaces")
            .select("id")
            .eq("workspace_id", workspaceId)
            .eq("kind", "general")
        ).data?.[0]?.id,
      { timeout: 30_000 },
    )
    .toBeTruthy();
  const { data: g } = await admin!
    .from("knowledge_spaces")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("kind", "general")
    .single();
  general = g!.id;
});

test("General: the ⓘ is an anchored card that closes outside and with Esc", async ({ page }, i) => {
  await signIn(page);
  await page.goto(`/knowledge/spaces/${general}`);
  const { text, tip } = await help(page, "Acerca de General");
  report.generalInfo = text.slice(0, 80);
  await page.screenshot({ path: i.outputPath("general-info.png") });
  await page.mouse.click(5, 5);
  await expect(tip).toHaveCount(0);
  await help(page, "Acerca de los Métodos");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("tooltip")).toHaveCount(0);
});

test("Methods: Material collapsed; Guardar closes the editor and the card appears", async ({
  page,
}, i) => {
  await signIn(page);
  await page.goto(`/knowledge/spaces/${general}`);
  await page.getByRole("button", { name: "Nuevo método" }).click();
  const dialog = page.locator("dialog[open]");
  await expect(dialog).toBeVisible();
  const material = dialog.getByRole("button", { name: /Material de apoyo/ });
  await expect(material).toHaveAttribute("aria-expanded", "false");
  await expect(dialog.getByText("Guardá el método para agregarle material.")).toBeHidden();
  await page.screenshot({ path: i.outputPath("new-method-collapsed.png") });
  await material.click();
  await expect(material).toHaveAttribute("aria-expanded", "true");
  await material.click();
  await expect(material).toHaveAttribute("aria-expanded", "false");

  const name = `Planificar el día ${i.project.name}`;
  await dialog.getByLabel("Nombre").fill(name);
  await dialog.getByLabel("¿Qué tiene que saber hacer ELISE?").fill("Cómo ordeno el día");
  await dialog.getByLabel("Instrucciones").fill("Primero lo urgente, después lo importante.");
  await dialog.getByRole("button", { name: "Guardar" }).click();
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  await expect(page.getByRole("button", { name: new RegExp(name) })).toBeVisible();
  report[`savedAndClosed:${i.project.name}`] = true;
  await page.screenshot({ path: i.outputPath("method-saved.png") });

  // Editing: the same rule.
  await page.getByRole("button", { name: new RegExp(name) }).click();
  const edit = page.locator("dialog[open]");
  await edit.getByLabel("¿Qué tiene que saber hacer ELISE?").fill("Cómo ordeno el día, versión 2");
  await edit.getByRole("button", { name: "Guardar" }).click();
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  await expect(page.getByText("Cómo ordeno el día, versión 2")).toBeVisible();
});

test("Conexiones and other sections use the same card, not the old blurred modal", async ({
  page,
}, i) => {
  await signIn(page);
  const sections: [string, string][] = [
    ["/connections", "Conexiones"],
    ["/chat", "Historial"],
    ["/schedules", "Programados"],
    ["/my-elise/tasks", "Tareas"],
    ["/my-elise/habits", "Hábitos"],
    ["/my-elise/goals", "Objetivos"],
  ];
  for (const [path, title] of sections) {
    await page.goto(path);
    const { text, tip } = await help(page, new RegExp(`Qué es ${title}`));
    report[`info:${title}`] = text.slice(0, 60);
    if (path === "/connections")
      await page.screenshot({ path: i.outputPath("connections-info.png") });
    await page.keyboard.press("Escape");
    await expect(tip).toHaveCount(0);
  }
  // A real action still opens a real dialog.
  await page.goto("/connections/google");
  const connect = page.getByRole("button", { name: /Conectar/ }).first();
  if (await connect.isVisible()) {
    await connect.click();
    await expect(page.locator("dialog[open]")).toBeVisible();
    await page.keyboard.press("Escape");
  }
});

import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

/**
 * Real-browser check of Home's bottom row: it stays within a centred band (never edge to edge),
 * fixed items keep one line, and the "Continuar" preview is cut to the room left — at every
 * width, with no horizontal scroll.
 *
 *   E2E_REAL=1 E2E_CHANNEL=chrome E2E_PORT=3100 npx playwright test home-continue-validation --project=desktop
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

const LONG =
  "Elis, porfa, ¿me agregás, este... pará que estoy pensando, dejame pensar. ¿Me agregás...? Agregame, agregame huevos. Agregame huevos a la lista de compras y acordate de llamar a Marco por el presupuesto de Firbot el jueves a la mañana, que quedó pendiente.";

test.beforeAll(async () => {
  email = `e2e+home-${Date.now()}@elise.test`;
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

test("setup: a long conversation to continue, tasks due and overdue", async ({ page }) => {
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
  const { data: conv, error } = await admin!
    .from("conversations")
    .insert({ workspace_id: workspaceId, user_id: userId, title: "Compras" })
    .select("id")
    .single();
  if (error) throw error;
  const now = new Date().toISOString();
  const { error: e2 } = await admin!.from("live_workspaces").insert({
    workspace_id: workspaceId,
    user_id: userId,
    conversation_id: conv!.id,
    intent: { id: "i1", kind: "general", description: LONG, startedAt: now },
    surfaces: [
      {
        id: "result:x",
        handle: "S1",
        type: "result",
        title: "x",
        state: "ready",
        priority: 50,
        size: "medium",
        source: null,
        ref: null,
        payload: { display: { kind: "x" } },
        actions: [],
        intentId: "i1",
        turn: 0,
        createdAt: now,
        updatedAt: now,
      },
    ],
  });
  if (e2) throw e2;
  const today = new Date().toISOString().slice(0, 10);
  const { data: list } = await admin!
    .from("task_lists")
    .select("id")
    .eq("workspace_id", workspaceId)
    .limit(1)
    .maybeSingle();
  for (const [title, due] of [
    ["Hoy uno", today],
    ["Hoy dos", today],
    ["Vieja", "2026-01-05"],
  ] as const) {
    const { error: e3 } = await admin!.from("tasks").insert({
      workspace_id: workspaceId,
      title,
      due_date: due,
      ...(list ? { task_list_id: list.id } : {}),
      created_by_user_id: userId,
    });
    if (e3) throw e3;
  }
});

const SIZES = [
  { name: "desktop-xl", width: 1910, height: 970 },
  { name: "laptop", width: 1366, height: 768 },
  // 125% / 150% zoom of a 1920 screen: the CSS viewport the page actually gets.
  { name: "zoom-125", width: 1536, height: 776 },
  { name: "zoom-150", width: 1280, height: 646 },
  { name: "tablet", width: 820, height: 1180 },
  { name: "mobile", width: 390, height: 844 },
];

for (const size of SIZES)
  test(`bottom row stays in its band: ${size.name}`, async ({ page }, i) => {
    await page.setViewportSize({ width: size.width, height: size.height });
    await signIn(page);
    await page.goto("/");
    const link = page.getByRole("link", { name: /Continuar:/ });
    await expect(link).toBeVisible();
    await expect(page.getByText("2 tareas")).toBeVisible();
    const row = link.locator("xpath=ancestor::ul[1]");
    const box = (await row.boundingBox())!;
    // Never edge to edge: at most 66rem (1056 px), centred, inside the viewport.
    expect(box.width).toBeLessThanOrEqual(1056 + 1);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(size.width);
    if (size.width >= 1200) {
      const center = box.x + box.width / 2;
      expect(Math.abs(center - size.width / 2)).toBeLessThan(24);
    }
    // One line each; the preview is the part that gets cut.
    for (const item of await row.locator(":scope > li").all()) {
      const h = (await item.boundingBox())!.height;
      expect(h).toBeLessThanOrEqual(34);
    }
    const preview = link.locator("span").last();
    const cut = await preview.evaluate((el) => el.scrollWidth > el.clientWidth);
    expect(cut).toBe(true);
    // No horizontal scroll anywhere.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await page.screenshot({ path: i.outputPath(`home-${size.name}.png`) });
  });

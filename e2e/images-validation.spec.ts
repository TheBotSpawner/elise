import { mkdirSync } from "node:fs";

import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

/**
 * Real validation of ADR-120 with the real model and the real image providers: a place's photos,
 * three beaches kept apart, "más fotos de la segunda", a product model never confused, no image
 * search for arithmetic, and the gallery's enlarged view.
 *
 *   E2E_REAL=1 E2E_CHANNEL=chrome E2E_PORT=3100 \
 *     npx playwright test images-validation --project=desktop
 */
const real = process.env.E2E_REAL === "1";
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
test.skip(!real || !url || !secret, "On demand: E2E_REAL=1 and Supabase");
test.describe.configure({ mode: "serial", timeout: 400_000 });

const admin = url && secret ? createClient(url, secret, { auth: { persistSession: false } }) : null;
const password = `E2e-${crypto.randomUUID()}`;
const OUT = "test-results/images";
let email = "";
let userId = "";
let workspaceId = "";
const report: Record<string, unknown> = {};

type Gallery = {
  groups: {
    name: string;
    context: string | null;
    images: {
      title: string;
      provider: string;
      sourcePageUrl: string;
      creator: string | null;
      license: string | null;
    }[];
  }[];
};

test.beforeAll(async ({}, info) => {
  mkdirSync(OUT, { recursive: true });
  email = `e2e+images-${info.project.name}-${Date.now()}@elise.test`;
  const { data, error } = await admin!.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: "QA", preferred_language: "es" },
  });
  if (error) throw error;
  userId = data.user.id;
});

test.afterAll(async () => {
  console.log(`VALIDATION ${JSON.stringify(report)}`);
  if (workspaceId) await admin!.from("workspaces").delete().eq("id", workspaceId);
  if (userId) await admin!.auth.admin.deleteUser(userId);
});

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").first().fill(email);
  await page.getByLabel("Contraseña").fill(password);
  await page.getByRole("button", { name: "Ingresar", exact: true }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));
}

async function ask(page: Page, text: string, fresh = true) {
  const since = new Date().toISOString();
  const started = Date.now();
  if (fresh) {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
  }
  const box = page.locator("textarea").first();
  if (!(await box.isVisible().catch(() => false)))
    await page.getByRole("button", { name: "Escribir" }).first().click();
  await box.fill(text);
  await box.press("Enter");
  // Done when ELISE's reply to this message is saved.
  await expect
    .poll(
      async () =>
        (
          await admin!
            .from("messages")
            .select("id")
            .eq("workspace_id", workspaceId)
            .eq("role", "assistant")
            .gt("created_at", since)
        ).data?.length ?? 0,
      { timeout: 180_000, intervals: [1_000] },
    )
    .toBeGreaterThan(0);
  const ms = Date.now() - started;
  await page.waitForTimeout(1_500);
  const { data: tools } = await admin!
    .from("tool_executions")
    .select("tool_name")
    .eq("workspace_id", workspaceId)
    .gte("started_at", since);
  const { data: ws } = await admin!
    .from("live_workspaces")
    .select("surfaces")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const surfaces = (ws?.surfaces ?? []) as { type: string; title: string; payload: unknown }[];
  const galleries = surfaces
    .filter((s) => s.type === "image_gallery")
    .map((s) => s.payload as Gallery);
  const reply = (await page.locator("body").innerText()).slice(-600);
  return { tools: tools ?? [], galleries, reply, ms };
}

const summary = (g: Gallery) =>
  g.groups.map((x) => ({
    name: x.name,
    context: x.context,
    photos: x.images.map(
      (i) => `${i.title.slice(0, 50)} · ${i.creator?.slice(0, 20)} · ${i.license} · ${i.provider}`,
    ),
  }));

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
  await admin!
    .from("user_profiles")
    .update({ onboarding_status: "skipped", timezone: "America/Argentina/Buenos_Aires" })
    .eq("id", userId);
  const { data: ws } = await admin!
    .from("workspaces")
    .select("id")
    .eq("owner_user_id", userId)
    .single();
  workspaceId = ws!.id as string;
});

test("a place, three beaches apart, 'más fotos de la segunda', the enlarged view", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);

  const one = await ask(page, "ELISE, mostrame fotos de la playa Kenepa Grandi en Curaçao");
  await page.screenshot({ path: `${OUT}/kenepa.png` });
  report.kenepa = {
    ms: one.ms,
    tools: one.tools.map((t) => t.tool_name),
    gallery: one.galleries.map(summary),
    reply: one.reply.slice(-300),
  };
  expect(one.tools.map((t) => t.tool_name)).toContain("web.images");
  expect(one.galleries.at(-1)?.groups[0]?.images.length ?? 0).toBeGreaterThan(0);

  // The enlarged view: whole photo, credit, "Ver fuente", Escape closes.
  await page
    .getByRole("button", { name: /Ampliar foto de/ })
    .first()
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("link", { name: /Ver fuente/ })).toBeVisible();
  await page.screenshot({ path: `${OUT}/kenepa-enlarged.png` });
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  const three = await ask(page, "Mostrame tres playas diferentes de Aruba");
  await page.screenshot({ path: `${OUT}/aruba-three.png` });
  const g = three.galleries.find((x) => x.groups.length >= 2);
  report.three = {
    ms: three.ms,
    tools: three.tools.map((t) => t.tool_name),
    gallery: g && summary(g),
    reply: three.reply.slice(-400),
  };
  expect(g?.groups.length ?? 0).toBeGreaterThanOrEqual(2);
  expect(new Set(g!.groups.map((x) => x.name)).size).toBe(g!.groups.length);

  const second = g!.groups[1]!.name;
  const more = await ask(page, "Mostrame más fotos de la segunda", false);
  await page.screenshot({ path: `${OUT}/more-second.png` });
  // The updated gallery holds that one subject, with photos not shown before.
  const before = new Set(g!.groups[1]!.images.map((i) => i.sourcePageUrl));
  const after = more.galleries.find(
    (x) => x.groups.length === 1 && x.groups[0]!.name.includes(second.split(" ")[0]!),
  );
  report.more = {
    ms: more.ms,
    expected: second,
    tools: more.tools.map((t) => t.tool_name),
    gallery: after && summary(after),
    reply: more.reply.slice(-300),
  };
  expect(more.tools.map((t) => t.tool_name)).toContain("web.images");
  expect(after).toBeDefined();
  expect(after!.groups[0]!.images.some((i) => !before.has(i.sourcePageUrl))).toBe(true);
});

test("a product model is never confused; arithmetic shows no images", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  const product = await ask(page, "¿Cómo es el Broadlink RM4C Mini? Mostrame fotos");
  report.product = {
    ms: product.ms,
    tools: product.tools.map((t) => t.tool_name),
    gallery: product.galleries.map(summary),
    reply: product.reply.slice(-300),
  };
  for (const gal of product.galleries)
    for (const grp of gal.groups)
      for (const im of grp.images) expect(im.title.toLowerCase()).toMatch(/rm4c/);

  const math = await ask(page, "¿Cuánto es 7×8?");
  report.math = { tools: math.tools.map((t) => t.tool_name), reply: math.reply.slice(-120) };
  expect(math.tools.map((t) => t.tool_name)).not.toContain("web.images");
});

test("images come on their own when they help: a person, two places, a logo", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  const person = await ask(page, "¿Quién es David Goggins?");
  await page.screenshot({ path: `${OUT}/person.png` });
  const two = await ask(page, "¿Cuál es mejor, la playa de Joao Pessoa o la de Aruba?");
  await page.screenshot({ path: `${OUT}/compare.png` });
  const logo = await ask(page, "¿Qué es Mercado Libre?");
  await page.screenshot({ path: `${OUT}/logo.png` });
  report.proactive = {
    person: {
      ms: person.ms,
      tools: person.tools.map((t) => t.tool_name),
      gallery: person.galleries.map(summary),
    },
    compare: {
      ms: two.ms,
      tools: two.tools.map((t) => t.tool_name),
      gallery: two.galleries.map(summary),
    },
    logo: {
      ms: logo.ms,
      tools: logo.tools.map((t) => t.tool_name),
      gallery: logo.galleries.map(summary),
    },
  };
  expect(person.tools.map((t) => t.tool_name)).toContain("web.images");
  expect(two.galleries.some((g) => g.groups.length >= 2)).toBe(true);
});

test("summary and web cards look the part (screenshots)", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await signIn(page);
  const iafs = await ask(page, "¿Qué es IAFS?");
  await page.screenshot({ path: `${OUT}/card-iafs.png` });
  const company = await ask(page, "¿Qué es OpenAI? Contame quién la dirige y desde cuándo existe");
  await page.screenshot({ path: `${OUT}/card-company.png` });
  report.cards = {
    iafs: iafs.tools.map((t) => t.tool_name),
    company: company.tools.map((t) => t.tool_name),
  };
});

test("a recipe and a how-to get their own cards (screenshots)", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await signIn(page);
  const recipe = await ask(page, "¿Cómo se hace una pasta cremosa de champiñones para dos?");
  await expect(page.getByText("Ingredientes").first()).toBeVisible();
  await page.screenshot({ path: `${OUT}/card-recipe.png` });
  const guide = await ask(page, "¿Cómo armo un escritorio de trabajo? Paso a paso");
  await expect(page.getByText(/de \d+ completados/).first()).toBeVisible();
  await page.screenshot({ path: `${OUT}/card-guide.png` });
  report.practical = {
    recipe: recipe.tools.map((t) => t.tool_name),
    guide: guide.tools.map((t) => t.tool_name),
  };
});

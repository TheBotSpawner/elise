import { readFileSync } from "node:fs";

import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

/**
 * Real acceptance of conversational vision (ADR-060) with the real model: the "Learning Paths"
 * whiteboard pasted with CTRL+V and acted on; attached, described, then acted on WITHOUT
 * re-attaching; still known after a reload; text paste untouched.
 *
 *   E2E_REAL=1 E2E_CHANNEL=chrome npx playwright test vision-validation --project=desktop
 */
const real = process.env.E2E_REAL === "1";
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
test.skip(!real || !url || !secret, "On demand: E2E_REAL=1 and Supabase");
test.describe.configure({ mode: "serial", timeout: 300_000 });

const admin = url && secret ? createClient(url, secret, { auth: { persistSession: false } }) : null;
const password = `E2e-${crypto.randomUUID()}`;
const IMAGE = readFileSync("e2e/fixtures/learning-paths.jpg");
const EXPECTED = [
  "Oferta & Posicionamiento",
  "Sistemas de Contenido",
  "Hooks",
  "Elevator Pitch",
  "Networking Eventos",
  "Discovery + Oferta",
  "Onboarding",
  "Scope & Expectativas",
  "Comunicación & Follow-up",
  "Dynamics 365",
  "Meta Coexistencia",
  "Chatbots Profesionales",
];
let email = "";
let userId = "";
let workspaceId = "";
let listId = "";
let conversationB = "";
const report: Record<string, unknown> = {};

test.beforeAll(async ({}, info) => {
  email = `e2e+vision-${info.project.name}-${Date.now()}@elise.test`;
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
  // E2E_KEEP=1 keeps the throwaway user to inspect a failed run (delete it afterwards).
  if (!userId || process.env.E2E_KEEP === "1") return;
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

/** Loose comparison: accents, case, "&"/"y", spacing. */
const loose = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/&| y /g, " ")
    .replace(/[^a-z0-9+]+/g, " ")
    .trim();

async function items() {
  const { data } = await admin!
    .from("list_items")
    .select("content, checked, notes")
    .eq("list_id", listId)
    .order("position");
  return data ?? [];
}

/** The assistant's last answer in the newest conversation (read from the database). */
async function lastAnswer(after: number) {
  let text = "";
  await expect
    .poll(
      async () => {
        const { data } = await admin!
          .from("messages")
          .select("content, created_at, conversation_id")
          .eq("workspace_id", workspaceId)
          .eq("role", "assistant")
          .order("created_at", { ascending: false })
          .limit(1);
        const m = data?.[0];
        if (!m || new Date(m.created_at).getTime() < after) return false;
        text = m.content;
        conversationB = m.conversation_id;
        return true;
      },
      { timeout: 120_000, intervals: [1_000] },
    )
    .toBe(true);
  return text;
}

/** The dock's text box (the Live Canvas starts in voice mode: "Escribir" opens it). */
async function textBox(page: Page) {
  const box = page.locator("#elise-ask");
  if (!(await box.isVisible())) await page.getByRole("button", { name: "Escribir" }).click();
  await expect(box).toBeVisible();
  return box;
}

async function send(page: Page, text: string) {
  const at = Date.now();
  const box = await textBox(page);
  await box.fill(text);
  await box.press("Enter");
  return at;
}

/** Puts the whiteboard on the real system clipboard (as PNG: what Chrome can write). */
async function copyImage(page: Page) {
  await page.evaluate(async (b64) => {
    // No fetch(data:): the app's CSP rightly blocks it.
    const blob = new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], {
      type: "image/jpeg",
    });
    const bmp = await createImageBitmap(blob);
    const canvas = Object.assign(document.createElement("canvas"), {
      width: bmp.width,
      height: bmp.height,
    });
    canvas.getContext("2d")!.drawImage(bmp, 0, 0);
    const png = await new Promise<Blob>((r) => canvas.toBlob((b) => r(b!), "image/png"));
    await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
  }, IMAGE.toString("base64"));
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
  const { data: list, error } = await admin!
    .from("lists")
    .insert({ workspace_id: workspaceId, name: "📚 Aprendizaje", created_by_user_id: userId })
    .select("id")
    .single();
  if (error) throw error;
  listId = list!.id;
});

test("A · CTRL+V the whiteboard, ask to add the items → 12 items in the list", async ({
  page,
  context,
}, i) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await page.goto("/");
  await copyImage(page);
  await (await textBox(page)).click();
  await page.keyboard.press("Control+V");
  const chip = page.getByRole("list", { name: "Archivos para el próximo mensaje" });
  await expect(chip.locator("img")).toBeVisible();
  await expect(chip.getByText(/pegada-.*\.png/)).toBeVisible();
  await page.screenshot({ path: i.outputPath("A-pasted.png") });
  await expect(chip.getByText("Subiendo…")).toHaveCount(0, { timeout: 30_000 });
  const at = await send(page, "Agregame estos items a la lista de aprendizajes.");
  await expect.poll(async () => (await items()).length, { timeout: 120_000 }).toBe(12);
  const got = await items();
  report.A_items = got.map((x) => `${x.checked ? "☑" : "☐"} ${x.content}`);
  report.A_answer = await lastAnswer(at);
  for (const want of EXPECTED)
    expect(
      // The section may come along as a prefix ("Marketing: Hooks"): context, not noise.
      got.some((x) => loose(x.content).endsWith(loose(want))),
      `missing ${want}`,
    ).toBe(true);
  const checkedA = got.filter((x) => x.checked).map((x) => loose(x.content));
  expect(checkedA).toHaveLength(1);
  expect(checkedA[0]).toMatch(/meta coexistencia$/);
  await page.screenshot({ path: i.outputPath("A-done.png") });
});

test("B/C · attach, describe; then act WITHOUT re-attaching", async ({ page }, i) => {
  await admin!.from("list_items").delete().eq("list_id", listId);
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await page.goto("/");
  // A new conversation (the Canvas reopens the last one).
  const fresh = page.getByRole("button", { name: "Nueva conversación" });
  if (await fresh.isVisible()) await fresh.click();
  // The paperclip, as a user does it.
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Adjuntar un archivo" }).click();
  await (
    await chooser
  ).setFiles({
    name: "Learning Paths.jpg",
    mimeType: "image/jpeg",
    buffer: IMAGE,
  });
  await page.getByText("Adjuntar a este mensaje").click();
  const chip = page.getByRole("list", { name: "Archivos para el próximo mensaje" });
  await expect(chip.getByText("Learning Paths.jpg")).toBeVisible();
  await expect(chip.getByText("Subiendo…")).toHaveCount(0, { timeout: 30_000 });
  let at = await send(page, "¿Qué dice esta imagen?");
  const described = await lastAnswer(at);
  report.B_answer = described;
  for (const section of ["marketing", "sales", "client success", "automation"])
    expect(loose(described)).toContain(section);
  // The sent image stays with the turn, as a thumbnail that opens larger.
  await expect(page.getByRole("button", { name: "Ver Learning Paths.jpg" })).toBeVisible();
  await page.screenshot({ path: i.outputPath("B-described.png") });

  at = await send(page, "Agregalos a Aprendizajes.");
  await expect.poll(async () => (await items()).length, { timeout: 120_000 }).toBe(12);
  report.C_answer = await lastAnswer(at);
  report.C_items = (await items()).map((x) => `${x.checked ? "☑" : "☐"} ${x.content}`);
  const checkedC = (await items()).filter((x) => x.checked).map((x) => loose(x.content));
  expect(checkedC).toHaveLength(1);
  expect(checkedC[0]).toMatch(/meta coexistencia$/);
});

test("D · after a reload, ELISE still knows what the image showed", async ({ page }, i) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await page.goto(`/chat/${conversationB}`);
  // The thumbnail survives the reload.
  // The Canvas reopens with the transcript folded: open it as a user would.
  await page.getByRole("button", { name: /Abrir transcripción/ }).click();
  const thumb = page.getByRole("button", { name: "Ver Learning Paths.jpg" });
  await expect(thumb).toBeVisible();
  await thumb.click();
  await expect(
    page.getByRole("dialog", { name: "Learning Paths.jpg" }).locator("img"),
  ).toBeVisible();
  await page.screenshot({ path: i.outputPath("D-preview.png") });
  await page.keyboard.press("Escape");
  const at = await send(page, "¿Cuál era el item marcado como completado en esa imagen?");
  const answer = await lastAnswer(at);
  report.D_answer = answer;
  expect(loose(answer)).toContain("meta coexistencia");
});

test("E · a normal text paste still pastes text", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await page.goto("/");
  await page.evaluate(() => navigator.clipboard.writeText("Texto pegado normal"));
  await (await textBox(page)).click();
  await page.keyboard.press("Control+V");
  await expect(page.locator("#elise-ask")).toHaveValue("Texto pegado normal");
  await expect(page.getByRole("list", { name: "Archivos para el próximo mensaje" })).toHaveCount(0);
});

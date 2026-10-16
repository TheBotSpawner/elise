import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

/**
 * Mobile-first QA matrix (ADR-066): every main screen at phone, tablet and desktop widths, with
 * a seeded throwaway account. Each screen must not scroll sideways; screenshots land in
 * test-results/mobile-matrix/<width>/ for review. On demand:
 *
 *   E2E_CHANNEL=chrome npx playwright test mobile-matrix --project=mobile
 *   MATRIX_WIDTHS=390 MATRIX_ROUTES=/my-elise/tasks,/schedules … to narrow it.
 */
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
test.skip(!url || !secret, "Needs a Supabase project");
test.describe.configure({ mode: "serial", timeout: 600_000 });

const admin = url && secret ? createClient(url, secret, { auth: { persistSession: false } }) : null;
const password = `E2e-${crypto.randomUUID()}`;
let email = "";
let userId = "";
let workspaceId = "";

const WIDTHS: [number, number][] = (
  process.env.MATRIX_WIDTHS?.split(",").map(Number) ?? [320, 360, 390, 430, 768, 1440]
).map((w) => [
  w,
  { 320: 568, 360: 800, 375: 667, 390: 844, 393: 852, 412: 915, 430: 932, 768: 1024 }[w as 320] ??
    900,
]);

const ROUTES = process.env.MATRIX_ROUTES?.split(",") ?? [
  "/",
  "/chat",
  "/knowledge",
  "SPACE",
  "/connections",
  "/schedules",
  "/my-elise/tasks",
  "/my-elise/habits",
  "/my-elise/lists",
  "/my-elise/goals",
  "/my-elise/notes",
  "/my-elise/finance",
  "/my-elise/time",
  "/settings",
];

const OUT = process.env.MATRIX_OUT ?? "test-results/mobile-matrix";

test.beforeAll(async ({}, info) => {
  email = `e2e+matrix-${info.project.name}-${Date.now()}@elise.test`;
  const { data, error } = await admin!.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: "Leo QA", preferred_language: "es" },
  });
  if (error) throw error;
  userId = data.user.id;
});

test.afterAll(async () => {
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

let spaceId = "";

async function seed() {
  await expect
    .poll(
      async () => (await admin!.from("user_profiles").select("id").eq("id", userId)).data?.length,
      {
        timeout: 30_000,
      },
    )
    .toBe(1);
  await admin!.from("user_profiles").update({ onboarding_status: "completed" }).eq("id", userId);
  workspaceId = (await admin!.from("workspaces").select("id").eq("owner_user_id", userId).single())
    .data!.id as string;
  const ws = { workspace_id: workspaceId };
  const today = new Date().toISOString().slice(0, 10);
  await admin!
    .from("tasks")
    .insert(
      [
        "Revisar propuesta para Northwind con el equipo comercial",
        "Pagar el hosting",
        "Llamar a Marcos",
        "Preparar la presentación del jueves",
        "Comprar regalo para Ana",
      ].map((title, i) => ({ ...ws, title, due_date: i < 2 ? today : null })),
    );
  const list = (
    await admin!
      .from("lists")
      .insert({ ...ws, name: "Compras" })
      .select("id")
      .single()
  ).data!;
  await admin!.from("lists").insert({ ...ws, name: "Lista de viaje" });
  await admin!.from("list_items").insert(
    ["Leche", "Yerba", "Pan", "Café", "Manzanas"].map((content, position) => ({
      ...ws,
      list_id: list.id,
      content,
      position,
    })),
  );
  await admin!.from("habits").insert(
    [
      ["Meditar", "daily", 1],
      ["Housekeeping", "weekly", 2],
      ["Leer 20 minutos", "daily", 1],
    ].map(([name, frequency_type, target_value]) => ({
      ...ws,
      name,
      frequency_type,
      target_value,
    })),
  );
  await admin!.from("goals").insert([
    { ...ws, title: "Correr 10k" },
    { ...ws, title: "Lanzar ELISE a 20 usuarios" },
  ]);
  await admin!
    .from("notes")
    .insert({ ...ws, title: "Ideas para el onboarding", content: "Una idea." });
  spaceId = (
    await admin!
      .from("knowledge_spaces")
      .insert({ ...ws, name: "Facultad" })
      .select("id")
      .single()
  ).data!.id as string;
}

/** Interactive elements whose tap area is under 40×40 (ADR-066 aims at 44). */
async function smallTargets(page: Page) {
  return page.evaluate(() =>
    [
      ...document.querySelectorAll<HTMLElement>(
        "a, button, [role=switch], [role=tab], input, select",
      ),
    ]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height || getComputedStyle(el).visibility === "hidden") return false;
        if (r.bottom < 0 || r.top > innerHeight) return false;
        // A touch-hit ::after counts as the tap area.
        const after = getComputedStyle(el, "::after");
        const w =
          after.content !== "none" ? Math.max(r.width, parseFloat(after.width) || 0) : r.width;
        const h =
          after.content !== "none" ? Math.max(r.height, parseFloat(after.height) || 0) : r.height;
        return w < 40 || h < 40;
      })
      .slice(0, 12)
      .map((el) =>
        (el.getAttribute("aria-label") ?? el.textContent ?? el.tagName).trim().slice(0, 40),
      ),
  );
}

test("matrix", async ({ page }) => {
  await seed();
  await signIn(page);
  const report: Record<string, unknown> = {};
  for (const scheme of (process.env.MATRIX_SCHEMES?.split(",") ?? ["dark"]) as (
    "dark" | "light"
  )[]) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const [w, h] of WIDTHS) {
      await page.setViewportSize({ width: w, height: h });
      const dir = join(OUT, `${scheme}-${w}`);
      mkdirSync(dir, { recursive: true });
      for (const raw of ROUTES) {
        const route = raw === "SPACE" ? `/knowledge/spaces/${spaceId}` : raw;
        await page.goto(route);
        await page.waitForLoadState("networkidle").catch(() => undefined);
        await page.waitForTimeout(400);
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        const name =
          raw === "SPACE" ? "space" : raw.replaceAll("/", "_").replace(/^_/, "") || "home";
        report[`${scheme} ${w} ${name}`] = {
          overflow,
          ...(w < 768 ? { small: await smallTargets(page) } : {}),
        };
        await page.screenshot({ path: join(dir, `${name}.png`) });
      }
    }
  }
  console.log(`MATRIX ${JSON.stringify(report, null, 1)}`);
  const sideways = Object.entries(report).filter(
    ([, v]) => (v as { overflow: number }).overflow > 1,
  );
  expect(sideways.map(([k]) => k)).toEqual([]);
});

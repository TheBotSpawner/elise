import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

/**
 * Real validation that ELISE reads requests by meaning (real model): a person named next to a
 * gift is who it's for, a quantity belongs to its item, and "recordá que…" goes to Memory, never
 * to Tasks. On demand:
 *
 *   E2E_REAL=1 E2E_CHANNEL=chrome npx playwright test intent-validation --project=desktop
 */
const real = process.env.E2E_REAL === "1";
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
test.skip(!real || !url || !secret, "On demand: E2E_REAL=1 and a Supabase project");
test.describe.configure({ mode: "serial", timeout: 300_000 });

const admin = url && secret ? createClient(url, secret, { auth: { persistSession: false } }) : null;
const password = `E2e-${crypto.randomUUID()}`;
let email = "";
let userId = "";
let workspaceId = "";
const lists: Record<string, string> = {};

test.beforeAll(async ({}, info) => {
  email = `e2e+intent-${info.project.name}-${Date.now()}@elise.test`;
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

const answers = async () =>
  (
    await admin!
      .from("messages")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId)
      .eq("role", "assistant")
  ).count ?? 0;

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").first().fill(email);
  await page.getByLabel("Contraseña").fill(password);
  await page.getByRole("button", { name: "Ingresar", exact: true }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));
}

async function say(page: Page, text: string) {
  const box = page.locator("#elise-ask");
  if (!(await box.isVisible().catch(() => false)))
    await page.getByRole("button", { name: "Escribir" }).first().click();
  const before = await answers();
  await box.fill(text);
  await box.press("Enter");
  // Done when ELISE's answer to this message is stored (the UI's busy state can lag).
  await expect.poll(answers, { timeout: 180_000, intervals: [2_000] }).toBeGreaterThan(before);
  const last = await admin!
    .from("messages")
    .select("content")
    .eq("workspace_id", workspaceId)
    .eq("role", "assistant")
    .order("created_at", { ascending: false })
    .limit(1);
  console.log("ELISE:", JSON.stringify(text), "→", JSON.stringify(last.data?.[0]?.content ?? ""));
  await page.waitForTimeout(1_500);
}

const items = async (list: string) =>
  ((await admin!.from("list_items").select("content, notes").eq("list_id", lists[list]!)).data ??
    []) as { content: string; notes: string | null }[];

test("setup", async () => {
  await expect
    .poll(
      async () => (await admin!.from("user_profiles").select("id").eq("id", userId)).data?.length,
      { timeout: 30_000 },
    )
    .toBe(1);
  await admin!.from("user_profiles").update({ onboarding_status: "completed" }).eq("id", userId);
  workspaceId = (await admin!.from("workspaces").select("id").eq("owner_user_id", userId).single())
    .data!.id as string;
  for (const name of ["🎁 Regalos", "🛍️ Compras"]) {
    const row = (
      await admin!.from("lists").insert({ workspace_id: workspaceId, name }).select("id").single()
    ).data!;
    lists[name] = row.id as string;
  }
});

// One browser session for every request: closing a page mid-answer is not what's under test.
test("requests are read by meaning", async ({ page }) => {
  await signIn(page);
  await page.goto("/");

  await test.step("a person next to a gift is who it's for, not an item", async () => {
    // As dictated: no punctuation between the gift and the person.
    await say(page, "Agregame a la lista de regalos cucharón Cande y también espátula Cande");
    const got = await items("🎁 Regalos");
    console.log("regalos:", JSON.stringify(got));
    expect(got).toHaveLength(2);
    expect(got.some((i) => /^cande$/i.test(i.content.trim()))).toBe(false);
    for (const i of got) expect(`${i.content} ${i.notes ?? ""}`).toMatch(/cande/i);
  });

  await test.step("a quantity belongs to its item", async () => {
    await say(page, "agregá a compras dos kilos de harina y leche");
    const got = await items("🛍️ Compras");
    console.log("compras:", JSON.stringify(got));
    expect(got).toHaveLength(2);
    expect(
      got.some((i) => /harina/i.test(i.content) && /(2|dos)/i.test(`${i.content} ${i.notes}`)),
    ).toBe(true);
  });

  await test.step("a dictated spelling is applied, not copied into the task", async () => {
    await say(page, "Agregame las tareas, por favor. Replicar sitio web espacio psi, con doble i.");
    await say(page, "anotá la tarea llamar a Delfi con F no con PH");
    await say(page, "agregá la tarea comprar leche, no, perdón, comprar yerba");
    const titles = (
      (await admin!.from("tasks").select("title").eq("workspace_id", workspaceId)).data ?? []
    ).map((t) => String(t.title));
    console.log("tasks:", JSON.stringify(titles));
    expect(titles).toHaveLength(3);
    expect(titles.some((t) => /psii/i.test(t) && !/doble/i.test(t))).toBe(true);
    expect(titles.some((t) => /delfi/i.test(t) && !/ph|con f/i.test(t))).toBe(true);
    expect(titles.some((t) => /yerba/i.test(t) && !/leche|perd[oó]n/i.test(t))).toBe(true);
    // Leave Tasks empty for the next step, which checks nothing lands there.
    await admin!.from("tasks").delete().eq("workspace_id", workspaceId);
  });

  await test.step("terse commands are done, not asked about", async () => {
    await say(page, "timer dos horas.");
    await say(page, "alarma 7");
    const timers = ((
      await admin!.from("timers").select("duration_ms, kind").eq("workspace_id", workspaceId)
    ).data ?? []) as { duration_ms: number | null; kind: string }[];
    const alarms = ((
      await admin!.from("alarms").select("local_time").eq("workspace_id", workspaceId)
    ).data ?? []) as { local_time: string }[];
    console.log("timers:", JSON.stringify(timers), "alarms:", JSON.stringify(alarms));
    expect(timers.some((t) => t.duration_ms === 2 * 60 * 60 * 1000)).toBe(true);
    expect(alarms.some((a) => a.local_time === "07:00")).toBe(true);
  });

  await test.step("'recordá que…' goes to Memory, never to Tasks", async () => {
    await say(page, "Elis, recordá que Cande es muy linda.");
    const tasks = (await admin!.from("tasks").select("title").eq("workspace_id", workspaceId)).data;
    const facts = (
      await admin!.from("memory_facts").select("value").eq("workspace_id", workspaceId)
    ).data;
    console.log("tasks:", JSON.stringify(tasks), "facts:", JSON.stringify(facts));
    expect(tasks ?? []).toHaveLength(0);
    expect((facts ?? []).some((f) => /cande/i.test(String(f.value)))).toBe(true);
  });
});

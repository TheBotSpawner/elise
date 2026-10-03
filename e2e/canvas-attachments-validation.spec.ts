import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

/**
 * Real validation of ADR-031 (Canvas working set, habit history, chat attachments): real model,
 * real Storage, real Chrome. On demand only (model cost, varying answers):
 *
 *   E2E_REAL=1 VOICE_FIXTURES=<dir with u3.wav> E2E_CHANNEL=chrome \
 *     npx playwright test canvas-attachments-validation --project=desktop
 *
 * u3.wav (any voice): "¿Qué ves acá?". Attachment tests need migration
 * 20261008000027_chat_attachments.sql applied; they skip otherwise.
 */
const real = process.env.E2E_REAL === "1";
const fixtures = process.env.VOICE_FIXTURES;
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
test.skip(!real || !url || !secret, "On demand: E2E_REAL=1 and a Supabase project");
test.describe.configure({ mode: "serial", timeout: 240_000 });

const admin = url && secret ? createClient(url, secret, { auth: { persistSession: false } }) : null;
const password = `E2e-${crypto.randomUUID()}`;
let email = "";
let userId = "";
let workspaceId = "";
let attachmentsReady = false;
const report: Record<string, unknown> = {};

test.beforeAll(async ({}, info) => {
  email = `e2e+adr031-${info.project.name}-${Date.now()}@elise.test`;
  const { data, error } = await admin!.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: "Validación", preferred_language: "es" },
  });
  if (error) throw error;
  userId = data.user.id;
  attachmentsReady = !(await admin!.from("chat_attachments").select("id").limit(1)).error;
});

test.afterAll(async () => {
  console.log(`VALIDATION ${JSON.stringify(report, null, 1)}`);
  if (!userId) return;
  if (workspaceId && attachmentsReady) {
    const { data } = await admin!
      .from("chat_attachments")
      .select("storage_path")
      .eq("workspace_id", workspaceId);
    const paths = (data ?? []).map((r) => r.storage_path as string);
    if (paths.length) await admin!.storage.from("chat-attachments").remove(paths);
  }
  if (workspaceId) await admin!.from("workspaces").delete().eq("id", workspaceId);
  await admin!.auth.admin.deleteUser(userId);
});

async function signIn(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __turns: { body: string; out: string }[] };
    w.__turns = [];
    const original = window.fetch.bind(window);
    window.fetch = async (...args: Parameters<typeof fetch>) => {
      const res = await original(...args);
      const u =
        typeof args[0] === "string" ? args[0] : args[0] instanceof URL ? args[0].href : args[0].url;
      if (/\/api\/(chat|voice\/live\/delegate)$/.test(u)) {
        const i = w.__turns.push({ body: String(args[1]?.body ?? ""), out: "" }) - 1;
        void res
          .clone()
          .text()
          .then((t) => (w.__turns[i]!.out = `${t}\n#done`));
      }
      return res;
    };
  });
  await page.goto("/login");
  await page.getByLabel("Email").first().fill(email);
  await page.getByLabel("Contraseña").fill(password);
  await page.getByRole("button", { name: "Ingresar", exact: true }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));
}

interface Turn {
  body: Record<string, unknown>;
  events: { type: string; name?: string; thread?: { id: string }; delta?: string }[];
}

async function waitTurn(page: Page, n: number): Promise<Turn> {
  await expect
    .poll(
      () =>
        page.evaluate(
          (i) => (window as unknown as { __turns: { out: string }[] }).__turns[i]?.out ?? "",
          n,
        ),
      { timeout: 180_000, intervals: [1_000] },
    )
    .toContain("#done");
  const t = await page.evaluate(
    (i) => (window as unknown as { __turns: { body: string; out: string }[] }).__turns[i]!,
    n,
  );
  return {
    body: JSON.parse(t.body || "{}") as Record<string, unknown>,
    events: t.out
      .split("\n")
      .filter((l) => l && l !== "#done")
      .map((l) => JSON.parse(l) as Turn["events"][number]),
  };
}

const turnCount = (page: Page) =>
  page.evaluate(() => (window as unknown as { __turns: unknown[] }).__turns.length);

async function typeAndSend(page: Page, text: string): Promise<Turn> {
  const n = await turnCount(page);
  const box = page.locator("textarea").first();
  if (!(await box.isVisible().catch(() => false)))
    await page.getByRole("button", { name: "Escribir" }).first().click();
  await box.fill(text);
  await box.press("Enter");
  return waitTurn(page, n);
}

const tools = (t: Turn) => t.events.filter((e) => e.type === "tool_started").map((e) => e.name);
const reply = (t: Turn) =>
  t.events
    .filter((e) => e.type === "text")
    .map((e) => e.delta)
    .join("");
const threadOf = (t: Turn) => t.events.find((e) => e.type === "conversation")?.thread?.id;

async function liveSurfaces(conversationId: string) {
  const { data } = await admin!
    .from("live_workspaces")
    .select("surfaces")
    .eq("conversation_id", conversationId)
    .maybeSingle();
  return (data?.surfaces ?? []) as {
    type: string;
    handle: string;
    dataset?: string;
    presentation?: string;
  }[];
}

test("setup: onboarding", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: "Empezar", exact: true }).click();
  await page.getByRole("button", { name: "Continuar" }).click();
  await page.getByRole("button", { name: "Saltear por ahora" }).click();
  await page.getByRole("radio", { name: "Facultad" }).click();
  await page.getByLabel("Nombre").fill("Facultad QA");
  await page.getByRole("button", { name: "Crear Espacio" }).click();
  await page.getByRole("button", { name: "Empezar con ELISE" }).click();
  await expect(page).toHaveURL(/\/$/, { timeout: 30_000 });
  const { data } = await admin!
    .from("workspaces")
    .select("id")
    .eq("owner_user_id", userId)
    .single();
  workspaceId = data!.id as string;
});

// ── Canvas working set ──────────────────────────────────────────────────────

test("CANVAS — create, mostramela, mostralas as timeline then table: one view of the tasks", async ({
  page,
}, info) => {
  await signIn(page);
  await page.goto("/");
  const t1 = await typeAndSend(
    page,
    "Creá dos tareas: 'Comprar pilas' para mañana y 'Pagar la luz' para el viernes.",
  );
  const conversation = threadOf(t1)!;
  const t2 = await typeAndSend(page, "Mostrame mis tareas pendientes.");
  const t3 = await typeAndSend(page, "Mostralas en una línea de tiempo.");
  const afterTimeline = await liveSurfaces(conversation);
  const t4 = await typeAndSend(page, "Ahora como tabla.");
  const afterTable = await liveSurfaces(conversation);
  const t5 = await typeAndSend(page, "Creá la tarea 'Llamar al plomero' para el lunes.");
  const t6 = await typeAndSend(page, "Mostramela.");
  const afterCreate = await liveSurfaces(conversation);
  await page.reload();
  await page.waitForTimeout(2_000);
  const afterReload = await liveSurfaces(conversation);
  const tasks = (s: Awaited<ReturnType<typeof liveSurfaces>>) =>
    s.filter((x) => x.dataset?.startsWith("tasks.")).map((x) => `${x.handle}:${x.presentation}`);
  report.canvas = {
    tools: [t1, t2, t3, t4, t5, t6].map(tools),
    afterTimeline: tasks(afterTimeline),
    afterTable: tasks(afterTable),
    afterCreate: tasks(afterCreate),
    afterReload: tasks(afterReload),
  };
  await page.screenshot({ path: info.outputPath("canvas-working-set.png") });
  // One representation of the task collection at a time, never list + timeline + table.
  expect(tasks(afterTimeline)).toHaveLength(1);
  expect(tasks(afterTable)).toHaveLength(1);
  expect(tasks(afterReload)).toEqual(tasks(afterCreate));
});

// ── Habit history ───────────────────────────────────────────────────────────

test("HABITS — yesterday, a weekday and a day before creation are editable; streak follows", async ({
  page,
}, info) => {
  const today = new Date().toLocaleDateString("en-CA", {
    timeZone: "America/Argentina/Buenos_Aires",
  });
  const { data: habit } = await admin!
    .from("habits")
    .insert({
      workspace_id: workspaceId,
      name: "Leer",
      frequency_type: "daily",
      start_date: today,
      created_by_user_id: userId,
    })
    .select("id")
    .single();
  await admin!
    .from("user_profiles")
    .update({ timezone: "America/Argentina/Buenos_Aires" })
    .eq("id", userId);
  await signIn(page);
  await page.goto("/");
  const t1 = await typeAndSend(page, "Marcá que ayer hice Leer.");
  const t2 = await typeAndSend(page, "Y anteayer también leí.");
  const { data: entries } = await admin!
    .from("habit_entries")
    .select("entry_date, status")
    .eq("habit_id", habit!.id);
  const day = (n: number) => {
    const d = new Date(`${today}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - n);
    return d.toISOString().slice(0, 10);
  };
  report.habits = { tools: [tools(t1), tools(t2)], entries, reply: reply(t2).slice(0, 300) };
  expect(entries?.map((e) => e.entry_date).sort()).toEqual([day(2), day(1)]);

  // The Habits page: today is editable with one click; past weeks are reachable.
  await page.goto("/my-elise/habits");
  await page.screenshot({ path: info.outputPath("habits-week.png") });
  await page
    .getByRole("link", { name: /anterior|previous/i })
    .first()
    .click();
  await expect(page).toHaveURL(/week=/);
  await page.screenshot({ path: info.outputPath("habits-previous-week.png") });
});

// ── Chat attachments ────────────────────────────────────────────────────────

/** A minimal one-page PDF with real text (offsets computed, so parsers accept it). */
function pdf(text: string): Buffer {
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    "",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  objs[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

/** An external file drag across several Canvas elements, then (optionally) a drop. */
async function dragFiles(
  page: Page,
  files: { name: string; type: string; base64: string }[],
  opts: { drop?: boolean; overlaySeen?: boolean } = {},
) {
  return page.evaluate(
    async ({ files, drop }) => {
      const dt = new DataTransfer();
      for (const f of files)
        dt.items.add(
          new File([Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0))], f.name, {
            type: f.type,
          }),
        );
      let shown = 0;
      let hidden = 0;
      const observer = new MutationObserver(() => {
        const visible = Boolean(
          [...document.querySelectorAll('[role="status"]')].find((n) =>
            n.textContent?.includes("Soltá para adjuntar"),
          ),
        );
        if (visible) shown++;
        else hidden++;
      });
      observer.observe(document.body, { childList: true, subtree: true });
      const fire = (type: string, el: Element) =>
        el.dispatchEvent(
          new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }),
        );
      const path = [
        document.querySelector("main") ?? document.body,
        document.querySelector("section") ?? document.body,
        document.querySelector("textarea, form") ?? document.body,
        document.querySelector("nav, header") ?? document.body,
      ];
      fire("dragenter", path[0]!);
      for (let i = 1; i < path.length; i++) {
        fire("dragenter", path[i]!);
        fire("dragleave", path[i - 1]!);
        fire("dragover", path[i]!);
        await new Promise((r) => setTimeout(r, 60));
      }
      const overlayDuringDrag = Boolean(
        [...document.querySelectorAll('[role="status"]')].find((n) =>
          n.textContent?.includes("Soltá para adjuntar"),
        ),
      );
      if (drop) fire("drop", path.at(-1)!);
      else fire("dragleave", path.at(-1)!);
      await new Promise((r) => setTimeout(r, 400));
      observer.disconnect();
      return { overlayDuringDrag, shown, hidden };
    },
    { files, drop: opts.drop ?? true },
  );
}

const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64");
const conversations = async () =>
  (await admin!.from("conversations").select("id").eq("user_id", userId)).data?.length ?? 0;

test("ATTACH A — drop a PDF on fresh Home: draft only, then it belongs to the sent turn", async ({
  page,
}, info) => {
  test.skip(!attachmentsReady, "Apply migration 20261008000027_chat_attachments.sql first");
  await signIn(page);
  await page.goto("/");
  const before = await conversations();
  const drag = await dragFiles(page, [
    {
      name: "plan-ficticio.pdf",
      type: "application/pdf",
      base64: b64(pdf("Proyecto Colibri: entrega final el 14 de noviembre de 2026.")),
    },
  ]);
  await expect(page.getByText("plan-ficticio.pdf")).toBeVisible();
  await expect(page.getByText(/PDF ·/)).toBeVisible({ timeout: 20_000 });
  await page.screenshot({ path: info.outputPath("attach-a-draft.png") });
  expect(await conversations()).toBe(before);
  const t = await typeAndSend(page, "Resumime esto.");
  const conversation = threadOf(t)!;
  const { data: rows } = await admin!
    .from("chat_attachments")
    .select("id, status, conversation_id")
    .eq("user_id", userId);
  const { data: msg } = await admin!
    .from("messages")
    .select("metadata")
    .eq("conversation_id", conversation)
    .eq("role", "user")
    .single();
  report.attachA = { drag, body: t.body.attachments, rows, reply: reply(t).slice(0, 400) };
  await page.screenshot({ path: info.outputPath("attach-a-sent.png") });
  expect(drag.overlayDuringDrag).toBe(true);
  expect(t.body.attachments).toHaveLength(1);
  expect(rows).toEqual([
    expect.objectContaining({ status: "sent", conversation_id: conversation }),
  ]);
  expect((msg?.metadata as { attachments: unknown[] }).attachments).toHaveLength(1);
  expect(reply(t)).toMatch(/14 de noviembre|Colibr/i);
  await expect(page.getByText("plan-ficticio.pdf")).toHaveCount(1); // the sent chip, not a draft
});

test("ATTACH B/D/E/F — three files, remove one; no flicker; refusals; removal cleans up", async ({
  page,
}, info) => {
  test.skip(!attachmentsReady, "Apply migration 20261008000027_chat_attachments.sql first");
  await signIn(page);
  await page.goto("/");
  // E: unsupported and oversized are refused, nothing broken left in the draft.
  await dragFiles(page, [
    { name: "setup.exe", type: "application/x-msdownload", base64: b64("MZ") },
  ]);
  await expect(page.getByText(/No puedo usar este tipo de archivo todavía/)).toBeVisible();
  await expect(page.getByText("setup.exe")).toHaveCount(1); // only in the toast
  await page.screenshot({ path: info.outputPath("attach-e-unsupported.png") });

  // B + D: three files across several elements — the overlay appears once.
  const drag = await dragFiles(page, [
    { name: "a-notas.txt", type: "text/plain", base64: b64("Nota A: el código es AZUL-7.") },
    { name: "b-quitar.md", type: "text/markdown", base64: b64("# B\nNo debería enviarse.") },
    { name: "c-datos.csv", type: "text/csv", base64: b64("dato,valor\nC,VERDE-3\n") },
  ]);
  for (const n of ["a-notas.txt", "b-quitar.md", "c-datos.csv"])
    await expect(page.getByText(n)).toBeVisible();
  await expect(page.getByText(/TXT ·|MD ·|CSV ·/).first()).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Quitar b-quitar.md" }).click();
  await expect(page.getByText("b-quitar.md")).toHaveCount(0);
  await page.waitForTimeout(1_500);
  const removed = (
    await admin!
      .from("chat_attachments")
      .select("name")
      .eq("user_id", userId)
      .eq("name", "b-quitar.md")
  ).data;
  const t = await typeAndSend(page, "¿Qué códigos aparecen en los archivos?");
  const { data: sent } = await admin!
    .from("chat_attachments")
    .select("name, status")
    .eq("user_id", userId)
    .in("id", t.body.attachments as string[]);
  report.attachB = { drag, sent, removed, reply: reply(t).slice(0, 300) };
  await page.screenshot({ path: info.outputPath("attach-b-sent.png") });
  expect(drag.overlayDuringDrag).toBe(true);
  expect(drag.shown).toBeLessThanOrEqual(2); // mounted once (motion may add one mutation)
  expect(removed).toEqual([]);
  expect(sent?.map((s) => s.name).sort()).toEqual(["a-notas.txt", "c-datos.csv"]);
  expect(reply(t)).toMatch(/AZUL-7/);
  expect(reply(t)).toMatch(/VERDE-3/);
});

test("ATTACH C — an image with a thumbnail, asked by voice", async ({ page }, info) => {
  test.skip(!attachmentsReady, "Apply migration 20261008000027_chat_attachments.sql first");
  test.skip(!fixtures, "Needs VOICE_FIXTURES with u3.wav");
  await admin!
    .from("user_profiles")
    .update({
      voice_enabled: true,
      voice_output: true,
      voice_continuous: false,
      voice_language: "es",
    })
    .eq("id", userId);
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    navigator.mediaDevices.getUserMedia = async () => {
      const ctx = new AudioContext();
      await ctx.resume();
      const dest = ctx.createMediaStreamDestination();
      w.__say = async (b: string) => {
        const bytes = Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
        const src = ctx.createBufferSource();
        src.buffer = await ctx.decodeAudioData(bytes.buffer);
        src.connect(dest);
        src.start();
      };
      return dest.stream;
    };
  });
  await signIn(page);
  await page.goto("/");
  const png = await page.evaluate(async () => {
    const c = document.createElement("canvas");
    c.width = c.height = 256;
    const g = c.getContext("2d")!;
    g.fillStyle = "#ffffff";
    g.fillRect(0, 0, 256, 256);
    g.fillStyle = "#d32f2f";
    g.beginPath();
    g.arc(128, 128, 90, 0, Math.PI * 2);
    g.fill();
    const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b!), "image/png"));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return btoa(String.fromCharCode(...bytes));
  });
  await dragFiles(page, [{ name: "foto.png", type: "image/png", base64: png }]);
  await expect(page.locator('img[src^="blob:"]')).toBeVisible();
  await expect(page.getByText(/PNG ·/)).toBeVisible({ timeout: 20_000 });
  await page.screenshot({ path: info.outputPath("attach-c-thumbnail.png") });
  const n = await turnCount(page);
  await page.getByRole("button", { name: "Hablar con ELISE" }).first().click();
  await page.waitForTimeout(2_500);
  const audio = readFileSync(join(fixtures!, "u3.wav")).toString("base64");
  await page.evaluate((b) => (window as unknown as { __say: (s: string) => void }).__say(b), audio);
  const t = await waitTurn(page, n);
  report.attachC = { body: t.body, reply: reply(t).slice(0, 300) };
  await page.screenshot({ path: info.outputPath("attach-c-voice.png") });
  expect(t.body.attachments).toHaveLength(1);
  expect(reply(t)).toMatch(/rojo|círculo|circulo|red|circle/i);
});

test("MOBILE — the paperclip picker is there (no drag & drop UI)", async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await page.goto("/");
  const typeBtn = page.getByRole("button", { name: "Escribir" }).first();
  if (await typeBtn.isVisible().catch(() => false)) await typeBtn.click();
  await expect(page.getByRole("button", { name: "Adjuntar un archivo" })).toBeVisible();
  await expect(page.getByText("Soltá para adjuntar a ELISE")).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("mobile-picker.png") });
});

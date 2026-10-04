import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

/**
 * Real-browser validation of ADR-033 (the Calendar Surface). On demand only.
 *
 * Part A (E2E_REAL=1): a throwaway account with a calendar Surface seeded into its Live
 * Workspace — every view, desktop and phone, placement checked on screen. No Google needed.
 *
 * Part B (E2E_GOOGLE_EMAIL + E2E_GOOGLE_PASSWORD: an ELISE account with Google Calendar
 * connected): the real flow — "Mostrame mi calendario de esta semana", view switches, and a
 * test event created, moved and deleted ("ELISE QA …", no guests).
 *
 *   E2E_REAL=1 E2E_CHANNEL=chrome npx playwright test calendar-validation --project=desktop
 */
const real = process.env.E2E_REAL === "1";
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
test.skip(!real || !url || !secret, "On demand: E2E_REAL=1 and a Supabase project");
test.describe.configure({ mode: "serial", timeout: 240_000 });

const admin = url && secret ? createClient(url, secret, { auth: { persistSession: false } }) : null;
const TZ = "America/Argentina/Buenos_Aires";
const password = `E2e-${crypto.randomUUID()}`;
let email = "";
let userId = "";
let workspaceId = "";
let conversationId = "";
const report: Record<string, unknown> = {};

// Local dates in the user's timezone.
const today = new Date().toLocaleDateString("en-CA", { timeZone: TZ });
const add = (d: string, n: number) => {
  const x = new Date(`${d}T12:00:00Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};
const monday = add(today, -((new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7));
const wed = add(monday, 2);
const thu = add(monday, 3);
const fri = add(monday, 4);
/** Buenos Aires is UTC−3 all year. */
const at = (d: string, hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return new Date(
    Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10), h! + 3, m!),
  ).toISOString();
};
const item = (id: string, title: string, start: string, end: string, calendar = "Personal") => ({
  id,
  calendarId: `cal-${calendar}`,
  calendarName: calendar,
  account: calendar === "Trabajo" ? "Acme" : "Personal",
  title,
  start,
  end,
  allDay: start.length === 10,
  status: "confirmed",
  location: null,
  description: null,
  meetingUrl: null,
  htmlUrl: null,
  attendees: 0,
});
const events = [
  item("m", "Weekly Meeting", at(wed, "10:00"), at(wed, "10:30")),
  item("t", "Teatro", at(wed, "20:00"), at(wed, "22:00")),
  item("b", "Cumpleaños", fri, add(fri, 1)),
  item("o1", "Dentista", at(thu, "09:00"), at(thu, "10:30")),
  item("o2", "Llamada", at(thu, "09:30"), at(thu, "10:00")),
  item("w", "Standup", at(thu, "12:00"), at(thu, "12:15"), "Trabajo"),
];

test.beforeAll(async ({}, info) => {
  email = `e2e+adr033-${info.project.name}-${Date.now()}@elise.test`;
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
  if (workspaceId) await admin!.from("workspaces").delete().eq("id", workspaceId);
  if (userId) await admin!.auth.admin.deleteUser(userId);
});

async function signIn(page: Page, who = email, pass = password) {
  await page.goto("/login");
  await page.getByLabel("Email").first().fill(who);
  await page.getByLabel("Contraseña").fill(pass);
  await page.getByRole("button", { name: "Ingresar", exact: true }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));
}

test("A · setup: onboarding and a conversation with a seeded calendar", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: "Empezar", exact: true }).click();
  await page.getByRole("button", { name: "Continuar" }).click();
  await page.getByRole("button", { name: "Saltear por ahora" }).click();
  await page.getByRole("radio", { name: "Facultad" }).click();
  await page.getByLabel("Nombre").fill("Facultad QA");
  await page.getByRole("button", { name: "Crear Espacio" }).click();
  await page.getByRole("button", { name: "Empezar con ELISE" }).click();
  await expect(page).toHaveURL(/\/$/, { timeout: 30_000 });
  await admin!.from("user_profiles").update({ timezone: TZ }).eq("id", userId);
  workspaceId = (await admin!.from("workspaces").select("id").eq("owner_user_id", userId).single())
    .data!.id as string;
  const { data: conv } = await admin!
    .from("conversations")
    .insert({ workspace_id: workspaceId, user_id: userId, title: "Mi calendario de esta semana" })
    .select("id")
    .single();
  conversationId = conv!.id as string;
  await admin!.from("messages").insert([
    {
      conversation_id: conversationId,
      workspace_id: workspaceId,
      role: "user",
      content: "Mostrame mi calendario de esta semana.",
    },
    {
      conversation_id: conversationId,
      workspace_id: workspaceId,
      role: "assistant",
      content: "Esta es tu semana.",
    },
  ]);
  // The whole year is loaded, so every view switch is presentation only (no provider read).
  const year = today.slice(0, 4);
  const now = new Date().toISOString();
  const surface = {
    id: "calendar:qa",
    handle: "S1",
    type: "calendar",
    title: "",
    state: "ready",
    priority: 82,
    size: "large",
    source: { capability: "calendar", label: null },
    ref: null,
    payload: {
      view: "week",
      anchor: today,
      range: { from: `${year}-01-01`, to: `${+year + 1}-01-01` },
      timezone: TZ,
      events,
      hidden: [],
      free: [],
      truncated: false,
    },
    actions: [{ id: "expand", kind: "expand" }],
    intentId: null,
    dataset: "calendar",
    query: { tool: "calendar.listEvents", args: { from: `${year}-01-01`, to: `${year}-12-31` } },
    turn: 1,
    createdAt: now,
    updatedAt: now,
  };
  const { error } = await admin!.from("live_workspaces").insert({
    workspace_id: workspaceId,
    user_id: userId,
    conversation_id: conversationId,
    surfaces: [surface],
    turn: 1,
    next_handle: 2,
    version: 1,
  });
  if (error) throw error;
});

test("A · desktop: Week places every event in its own day; views switch in the same Surface", async ({
  page,
}, info) => {
  await signIn(page);
  await page.goto(`/chat/${conversationId}`);
  const meeting = page.getByRole("button", { name: /^Weekly Meeting, miércoles/ });
  await expect(meeting).toBeVisible();
  const header = page.getByRole("button", { name: new RegExp(`^Ver el miércoles`) }).first();
  const [mb, hb] = [await meeting.boundingBox(), await header.boundingBox()];
  const theatre = await page.getByRole("button", { name: /^Teatro, miércoles/ }).boundingBox();
  const birthday = await page.getByRole("button", { name: /^Cumpleaños, viernes/ }).boundingBox();
  const friday = await page
    .getByRole("button", { name: /^Ver el viernes/ })
    .first()
    .boundingBox();
  const inColumn = (b: typeof mb, h: typeof hb) =>
    Boolean(b && h && b.x + b.width / 2 >= h.x && b.x + b.width / 2 <= h.x + h.width);
  const dentist = await page.getByRole("button", { name: /^Dentista/ }).boundingBox();
  const call = await page.getByRole("button", { name: /^Llamada/ }).boundingBox();
  report.week = {
    meetingInWednesday: inColumn(mb, hb),
    theatreInWednesday: inColumn(theatre, hb),
    birthdayInFriday: inColumn(birthday, friday),
    overlapSideBySide: Boolean(dentist && call && call.x >= dentist.x + dentist.width - 2),
  };
  expect(report.week).toEqual({
    meetingInWednesday: true,
    theatreInWednesday: true,
    birthdayInFriday: true,
    overlapSideBySide: true,
  });
  await page.screenshot({ path: info.outputPath("week-desktop.png") });

  const views = page.getByRole("group", { name: "Vista" });
  const surfaces = async () =>
    (
      await admin!
        .from("live_workspaces")
        .select("surfaces")
        .eq("conversation_id", conversationId)
        .single()
    ).data!.surfaces as { id: string; payload: { view: string; anchor: string } }[];
  for (const [label, view] of [
    ["Agenda", "agenda"],
    ["Mes", "month"],
    ["Año", "year"],
    ["Día", "day"],
  ] as const) {
    await views.getByRole("button", { name: label }).click();
    await expect(views.getByRole("button", { name: label })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect.poll(async () => (await surfaces())[0]!.payload.view).toBe(view);
    expect((await surfaces()).map((s) => s.id)).toEqual(["calendar:qa"]); // same Surface
    await page.screenshot({ path: info.outputPath(`${view}-desktop.png`) });
  }
  // Agenda groups by date; Month's day opens Day; Year's month opens Month.
  await views.getByRole("button", { name: "Agenda" }).click();
  await expect(page.getByRole("region", { name: /miércoles/ }).getByText("Teatro")).toBeVisible();
  await views.getByRole("button", { name: "Mes" }).click();
  await page
    .getByRole("button", { name: /^Ver el jueves/ })
    .first()
    .click();
  await expect(views.getByRole("button", { name: "Día" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: /^Dentista/ })).toBeVisible();
  // Event detail without leaving the Canvas.
  await page.getByRole("button", { name: /^Standup/ }).click();
  await expect(page.getByRole("dialog", { name: "Standup" })).toContainText("Trabajo");
  await page.screenshot({ path: info.outputPath("detail-desktop.png") });
  await page.keyboard.press("Escape");
  // Filtering a calendar hides only its events.
  await views.getByRole("button", { name: "Semana" }).click();
  await page.getByText("Calendarios").click();
  await page.getByRole("checkbox", { name: /Trabajo/ }).uncheck();
  await expect(page.getByRole("button", { name: /^Standup/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Dentista/ })).toBeVisible();
});

test("A · regression: Week → Year → Week keeps the week; rapid switches end on Week", async ({
  page,
}, info) => {
  // Only this week is loaded: Year and Month must read more (no Google here, so those reads
  // fail) — what is known must survive, and returning to the week must need nothing.
  const { data: conv } = await admin!
    .from("conversations")
    .insert({ workspace_id: workspaceId, user_id: userId, title: "Semana (regresión)" })
    .select("id")
    .single();
  const id = conv!.id as string;
  await admin!.from("messages").insert([
    { conversation_id: id, workspace_id: workspaceId, role: "user", content: "Mi semana." },
    { conversation_id: id, workspace_id: workspaceId, role: "assistant", content: "Tu semana." },
  ]);
  const now = new Date().toISOString();
  const week = { from: monday, to: add(monday, 7) };
  await admin!.from("live_workspaces").insert({
    workspace_id: workspaceId,
    user_id: userId,
    conversation_id: id,
    surfaces: [
      {
        id: "calendar:week",
        handle: "S1",
        type: "calendar",
        title: "",
        state: "ready",
        priority: 82,
        size: "large",
        source: { capability: "calendar", label: null },
        ref: null,
        payload: {
          view: "week",
          anchor: today,
          range: week,
          timezone: TZ,
          events: events.slice(0, 3),
          hidden: [],
          free: [],
          truncated: false,
          loaded: [week],
          scope: "all",
          seq: 0,
        },
        actions: [{ id: "expand", kind: "expand" }],
        intentId: null,
        dataset: "calendar",
        query: { tool: "calendar.listEvents", args: { from: monday, to: add(monday, 6) } },
        turn: 1,
        createdAt: now,
        updatedAt: now,
      },
    ],
    turn: 1,
    next_handle: 2,
    version: 1,
  });
  await signIn(page);
  await page.goto(`/chat/${id}`);
  const views = page.getByRole("group", { name: "Vista" });
  const weekEvents = [/^Weekly Meeting, miércoles/, /^Teatro, miércoles/, /^Cumpleaños, viernes/];
  const visible = async () => {
    const out: boolean[] = [];
    for (const name of weekEvents)
      out.push(
        await page
          .getByRole("button", { name })
          .isVisible()
          .catch(() => false),
      );
    return out;
  };
  await expect.poll(visible).toEqual([true, true, true]);
  await views.getByRole("button", { name: "Año" }).click();
  await expect(views.getByRole("button", { name: "Año" })).toHaveAttribute("aria-pressed", "true");
  await page.waitForTimeout(2_500); // the year read finishes (and fails: no Google here)
  await page.screenshot({ path: info.outputPath("regression-year.png") });
  const t0 = Date.now();
  await views.getByRole("button", { name: "Semana" }).click();
  await expect(page.getByRole("button", { name: weekEvents[0] })).toBeVisible();
  const backMs = Date.now() - t0;
  await expect.poll(visible).toEqual([true, true, true]);
  await page.screenshot({ path: info.outputPath("regression-week-again.png") });

  // Rapid: Week → Year → Month → Week before the reads answer.
  await views.getByRole("button", { name: "Año" }).click();
  await views.getByRole("button", { name: "Mes" }).click();
  await views.getByRole("button", { name: "Semana" }).click();
  await page.waitForTimeout(4_000); // every late answer has arrived
  await expect(views.getByRole("button", { name: "Semana" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect.poll(visible).toEqual([true, true, true]);
  // Server actions run one at a time per client: the queued clicks persist in order.
  const read = async () =>
    (await admin!.from("live_workspaces").select("surfaces").eq("conversation_id", id).single())
      .data!.surfaces as { payload: { view: string; events: { id: string }[] } }[];
  const settledAt = Date.now();
  await expect.poll(async () => (await read())[0]!.payload.view, { timeout: 20_000 }).toBe("week");
  const persistMs = Date.now() - settledAt + 4_000;
  const stored = await read();
  report.regression = {
    backToWeekMs: backMs,
    rapidPersistedWithinMs: persistMs,
    storedView: stored[0]!.payload.view,
    storedEvents: stored[0]!.payload.events.map((e) => e.id),
  };
  expect(stored).toHaveLength(1);
  expect(stored[0]!.payload.view).toBe("week");
  expect(stored[0]!.payload.events.map((e) => e.id).sort()).toEqual(["b", "m", "t"]);
  await page.reload();
  await expect.poll(visible).toEqual([true, true, true]);
});

test("A · phone: Day, Week (strip + day), Month, Year, Agenda without overflow", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await page.goto(`/chat/${conversationId}`);
  const views = page.getByRole("group", { name: "Vista" });
  await views.waitFor();
  const overflow: Record<string, boolean> = {};
  for (const [label, view] of [
    ["Semana", "week"],
    ["Día", "day"],
    ["Mes", "month"],
    ["Año", "year"],
    ["Agenda", "agenda"],
  ] as const) {
    await views.getByRole("button", { name: label }).click();
    await page.waitForTimeout(300);
    overflow[view] = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    await page.screenshot({ path: info.outputPath(`${view}-phone.png`), fullPage: true });
  }
  report.phoneOverflow = overflow;
  expect(Object.values(overflow).some(Boolean)).toBe(false);
});

// ── Part B: a real connected Google Calendar ──────────────────────────────────

const googleEmail = process.env.E2E_GOOGLE_EMAIL;
const googlePassword = process.env.E2E_GOOGLE_PASSWORD;

test("B · real Google Calendar: this week, view switch, create/move/delete a test event", async ({
  page,
}, info) => {
  test.skip(!googleEmail || !googlePassword, "Needs E2E_GOOGLE_EMAIL / E2E_GOOGLE_PASSWORD");
  await signIn(page, googleEmail, googlePassword);
  await page.goto("/?new=qa");
  const ask = async (text: string) => {
    const box = page.locator("textarea").first();
    if (!(await box.isVisible().catch(() => false)))
      await page.getByRole("button", { name: "Escribir" }).first().click();
    await box.fill(text);
    await box.press("Enter");
    await expect(page.getByRole("button", { name: "Detener" })).toHaveCount(0, {
      timeout: 150_000,
    });
  };
  await ask("Mostrame mi calendario de esta semana.");
  const views = page.getByRole("group", { name: "Vista" });
  await expect(views.getByRole("button", { name: "Semana" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.screenshot({ path: info.outputPath("google-week.png") });
  await views.getByRole("button", { name: "Mes" }).click();
  await expect(views.getByRole("button", { name: "Mes" })).toHaveAttribute("aria-pressed", "true");
  await views.getByRole("button", { name: "Semana" }).click();
  const title = `ELISE QA calendario ${Date.now().toString(36)}`;
  await ask(`Creá un evento "${title}" el ${thu} a las 15:00, sin invitados.`);
  await expect(page.getByRole("button", { name: new RegExp(`^${title}, jueves`) })).toBeVisible({
    timeout: 30_000,
  });
  await ask(`Mové "${title}" al viernes a la misma hora.`);
  await expect(page.getByRole("button", { name: new RegExp(`^${title}, viernes`) })).toBeVisible({
    timeout: 30_000,
  });
  await ask(`Borrá el evento "${title}".`);
  const approve = page.getByRole("button", { name: /Aprobar|Confirmar/ }).first();
  if (await approve.isVisible().catch(() => false)) await approve.click();
  await expect(page.getByRole("button", { name: new RegExp(`^${title}`) })).toHaveCount(0, {
    timeout: 60_000,
  });
  await page.screenshot({ path: info.outputPath("google-after.png") });
});

import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

/**
 * Real-browser check of the Knowledge / Methods refinement (ADR-059): ⓘ instead of permanent
 * helper copy, "Agregar fuente" / "Subir documentos", back links, "Armar el método" with the
 * real model (three distinct fields), scope from where the form was opened, .md/.txt import,
 * and the Connections layout fixes.
 *
 *   E2E_REAL=1 E2E_CHANNEL=chrome npx playwright test knowledge-methods-validation --project=desktop
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
const ids = { general: "", firbot: "", section: "" };
const report: Record<string, unknown> = {};

/** The detailed planning Method the user wrote in the real UI. */
const PLANNING = `Siempre que Leo quiera planificar su dia vas a seguir los siguientes pasos.

Paso 1 - Vas a consultar los eventos de sus calendarios de toda la semana, y vas a informarlos. Comentale los de toda la semana, no solo de mañana.

Paso 2 - Una vez Leo te informe sobre las tareas que quiere realizar mañana, vas a armar una planificación en bloques de su día. También dale recomendaciones personalizadas según el día para un mejor aprovechamiento del tiempo y para que pueda anticiparse a cosas importantes (Ej. llevar sus cuadernos de estudio si va a realizar la clase desde algún lugar, llevar su tarjeta de transporte SUBE si tiene que salir con sus amigos). Una vez terminado vas a pedirle una confirmación.

Recomendaciones a tener en cuenta:
- Tratá de ser lo más eficiente posible con los tiempos (Ej. si viaja en colectivo, puede leer durante el viaje).
- Pensá en "temas" y no solo tareas. Planificá por bloques de tipos de actividades para agrupar esfuerzos mentales similares.
- Dejá colchones de 5-10 minutos por bloque para no sobrecargarlos.
- Permití margen en tu planificación para no manejarse con tiempos justos (bloques un poco más largos de lo necesario).
- Que haya tiempos de descanso también es importante en algún momento del día.`;

test.beforeAll(async ({}, info) => {
  email = `e2e+knowledge-${info.project.name}-${Date.now()}@elise.test`;
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

/** Opens an ⓘ by click and returns its card text; closes it with Esc. */
async function info(page: Page, label: string) {
  await page.getByRole("button", { name: label }).first().click();
  const tip = page.getByRole("tooltip");
  await expect(tip).toBeVisible();
  const text = await tip.innerText();
  const box = (await tip.boundingBox())!;
  const vw = page.viewportSize()!.width;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(vw);
  await page.keyboard.press("Escape");
  await expect(tip).toHaveCount(0);
  return text;
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
  const { data: general } = await admin!
    .from("knowledge_spaces")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("kind", "general")
    .single();
  ids.general = general!.id;
  const { data: firbot } = await admin!
    .from("knowledge_spaces")
    .insert({
      workspace_id: workspaceId,
      name: "Firbot Marketing",
      description: "Marketing de Firbot Solutions y Firbot Academy",
      created_by_user_id: userId,
    })
    .select("id")
    .single();
  ids.firbot = firbot!.id;
  const { data: section } = await admin!
    .from("knowledge_spaces")
    .insert({
      workspace_id: workspaceId,
      name: "Redes",
      parent_space_id: ids.firbot,
      created_by_user_id: userId,
    })
    .select("id")
    .single();
  ids.section = section!.id;
});

test("General: calm page, ⓘ explanations, coherent actions, back link", async ({ page }, i) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await page.goto(`/knowledge/spaces/${ids.general}`);
  await expect(page.getByRole("heading", { level: 1, name: /General/ })).toBeVisible();
  // Helper copy is gone from the page…
  for (const gone of [
    "Contexto y formas de trabajar que ELISE usa en todos tus espacios.",
    /Este es el contexto general de ELISE/,
    /Formas de trabajar que ELISE usa en cualquier área/,
    /Archivos subidos, Google Drive, Notion y Notas de ELISE pueden convivir/,
    /Enseñale a ELISE cómo querés que haga algo/,
    /Sumar/,
  ])
    await expect(page.getByText(gone)).toHaveCount(0);
  // …and available behind ⓘ.
  report.generalInfo = await info(page, "Acerca de General");
  expect(report.generalInfo).toMatch(/espacio predeterminado de ELISE/);
  expect(await info(page, "Acerca del contexto")).toMatch(/qué debe saber/);
  const methods = await info(page, "Acerca de los Métodos");
  expect(methods).toMatch(/Los Métodos de General/);
  expect(methods).toMatch(/Cuando planifiques mi día/);
  expect(await info(page, "Acerca de las fuentes")).toMatch(/Un Espacio puede combinar/);
  // Hover opens it too (desktop).
  await page.mouse.move(5, 5);
  await page.getByRole("button", { name: "Acerca de las fuentes" }).hover();
  await expect(page.getByRole("tooltip")).toBeVisible();
  await page.mouse.move(5, 5);
  await expect(page.getByRole("tooltip")).toHaveCount(0);

  await expect(page.getByText("Todavía no hay métodos.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Agregar fuente" }).first()).toBeVisible();
  await expect(page.getByText("Subir documentos")).toBeVisible();
  await expect(page.getByRole("button", { name: "Nuevo método" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Importar método" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Agregar contexto" })).toBeVisible();
  await page.screenshot({ path: i.outputPath("general-light.png"), fullPage: true });

  // Agregar fuente opens the add flow with the same vocabulary.
  await page.getByRole("button", { name: "Agregar fuente" }).first().click();
  const add = page.getByRole("dialog");
  await expect(add.getByText("Subir documentos")).toBeVisible();
  await page.screenshot({ path: i.outputPath("add-source.png") });
  await page.keyboard.press("Escape");

  // Back: an arrow + "Conocimiento", the whole control is the link.
  const back = page.getByRole("link", { name: "Volver a Conocimiento" });
  await expect(back).toBeVisible();
  expect(await back.locator("svg").count()).toBe(1);
  await back.click();
  await page.waitForURL("**/knowledge");
});

test("a Space and its Section: ⓘ per scope; Section → Space back link", async ({ page }, i) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await page.goto(`/knowledge/spaces/${ids.firbot}`);
  await expect(page.getByText("Marketing de Firbot Solutions y Firbot Academy")).toBeVisible();
  expect(await info(page, "Acerca de los Métodos")).toMatch(/en este Espacio/);
  await expect(page.getByRole("button", { name: "Acerca de Firbot Marketing" })).toHaveCount(0);
  await page.screenshot({ path: i.outputPath("space-light.png"), fullPage: true });

  await page.goto(`/knowledge/spaces/${ids.section}`);
  expect(await info(page, "Acerca de los Métodos")).toMatch(/Firbot Marketing/);
  const back = page.getByRole("link", { name: "Volver a Firbot Marketing" });
  await expect(back).toBeVisible();
  await back.click();
  await page.waitForURL(`**/knowledge/spaces/${ids.firbot}`);
});

test("Armar el método (real model): the planning Method gets three distinct fields, saved in General", async ({
  page,
}, i) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await page.goto(`/knowledge/spaces/${ids.general}`);
  await page.getByRole("button", { name: "Nuevo método" }).click();
  const dialog = page.getByRole("dialog", { name: "Nuevo método" });
  await expect(dialog.getByText("Dónde aplica")).toHaveCount(0);
  await expect(dialog.getByText("Se guardará en General.")).toBeVisible();
  await dialog.getByLabel("Contale a ELISE cómo querés que lo haga").fill(PLANNING);
  await dialog.getByRole("button", { name: "Armar el método" }).click();
  const name = dialog.getByLabel("Nombre");
  await expect(name).not.toHaveValue("", { timeout: 90_000 });
  const fields = {
    name: await name.inputValue(),
    capability: await dialog.getByLabel("¿Qué tiene que saber hacer ELISE?").inputValue(),
    instructions: await dialog.getByLabel("Instrucciones").inputValue(),
  };
  report.planning = fields;
  expect(fields.name.split(/\s+/).length).toBeLessThanOrEqual(7);
  expect(fields.name).not.toMatch(/^Siempre que/i);
  expect(fields.capability).not.toBe(fields.name);
  expect(fields.capability.length).toBeLessThan(240);
  expect(fields.instructions).not.toBe(PLANNING);
  expect(fields.instructions).not.toMatch(/^Siempre que Leo quiera/);
  // Important constraints survive.
  expect(fields.instructions).toMatch(/5.?(-|a|–).?10/);
  expect(fields.instructions).toMatch(/SUBE/);
  expect(fields.instructions).toMatch(/semana/i);
  await page.screenshot({ path: i.outputPath("method-planning.png") });
  await dialog.getByRole("button", { name: "Guardar", exact: true }).click();
  await expect
    .poll(
      async () =>
        (
          await admin!
            .from("methods")
            .select("space_id")
            .eq("workspace_id", workspaceId)
            .eq("name", fields.name)
        ).data,
    )
    .toEqual([{ space_id: null }]);
});

test("Armar el método (real model): a short messy text in a Space, saved in that Space", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await page.goto(`/knowledge/spaces/${ids.firbot}`);
  await page.getByRole("button", { name: "Nuevo método" }).click();
  const dialog = page.getByRole("dialog", { name: "Nuevo método" });
  await expect(dialog.getByText("Se guardará en Firbot Marketing.")).toBeVisible();
  await dialog
    .getByLabel("Contale a ELISE cómo querés que lo haga")
    .fill(
      "eh cuando me armes un post para linkedin q sea corto, sin emojis, q arranque con una pregunta y al final un llamado a la accion a la web de firbot academy",
    );
  await dialog.getByRole("button", { name: "Armar el método" }).click();
  const name = dialog.getByLabel("Nombre");
  await expect(name).not.toHaveValue("", { timeout: 90_000 });
  const fields = {
    name: await name.inputValue(),
    capability: await dialog.getByLabel("¿Qué tiene que saber hacer ELISE?").inputValue(),
    instructions: await dialog.getByLabel("Instrucciones").inputValue(),
  };
  report.short = fields;
  expect(fields.name.split(/\s+/).length).toBeLessThanOrEqual(7);
  expect(new Set([fields.name, fields.capability, fields.instructions]).size).toBe(3);
  expect(fields.instructions).toMatch(/emoji/i);
  await dialog.getByRole("button", { name: "Guardar", exact: true }).click();
  await expect
    .poll(
      async () =>
        (
          await admin!
            .from("methods")
            .select("space_id")
            .eq("workspace_id", workspaceId)
            .eq("name", fields.name)
        ).data,
    )
    .toEqual([{ space_id: ids.firbot }]);
});

test("import: .md and .txt become Methods; other files are refused", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await page.goto(`/knowledge/spaces/${ids.section}`);
  const input = page.locator('input[type="file"][accept=".md,.txt"]');
  const imported = async () =>
    (
      await admin!
        .from("methods")
        .select("name")
        .eq("workspace_id", workspaceId)
        .eq("space_id", ids.section)
    ).data?.length ?? 0;
  await input.setInputFiles({
    name: "Revisar copy.md",
    mimeType: "text/markdown",
    buffer: Buffer.from(
      "# Revisar copy\n\nRevisar textos antes de publicarlos.\n\n## Pasos\n1. Leé el texto.\n2. Corregí errores.",
    ),
  });
  await expect.poll(imported, { timeout: 20_000 }).toBe(1);
  await page.keyboard.press("Escape");
  await input.setInputFiles({
    name: "Responder comentarios.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Responder comentarios\n\n1. Agradecé.\n2. Respondé en una línea."),
  });
  await expect.poll(imported, { timeout: 20_000 }).toBe(2);
  await page.keyboard.press("Escape");
  await input.setInputFiles({
    name: "brochure.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.7 binary"),
  });
  await expect(
    page.getByText("Los Métodos se pueden importar desde archivos .md o .txt."),
  ).toBeVisible();
  const { data } = await admin!
    .from("methods")
    .select("name, space_id")
    .eq("workspace_id", workspaceId)
    .eq("space_id", ids.section);
  report.imported = data;
  expect(data).toHaveLength(2);
});

test("dark mode, narrow and mobile: ⓘ cards stay on screen, no overflow", async ({ page }, i) => {
  await admin!.from("user_profiles").update({ theme: "dark" }).eq("id", userId);
  await page.emulateMedia({ colorScheme: "dark" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await page.goto(`/knowledge/spaces/${ids.general}`);
  await page.getByRole("button", { name: "Acerca de los Métodos" }).click();
  await page.screenshot({ path: i.outputPath("general-dark-info.png") });
  await page.keyboard.press("Escape");
  for (const [w, h] of [
    [820, 1180],
    [390, 844],
  ]) {
    await page.setViewportSize({ width: w, height: h });
    await page.goto(`/knowledge/spaces/${ids.general}`);
    await info(page, "Acerca de General");
    await page.getByRole("button", { name: "Acerca de los Métodos" }).click();
    await page.screenshot({ path: i.outputPath(`general-dark-${w}.png`) });
    await page.keyboard.press("Escape");
    report[`overflow${w}`] = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(report[`overflow${w}`]).toBe(0);
  }
});

test("Connections: descriptions are whole (≤ 2 lines); Microsoft's Conectar is not cut", async ({
  page,
}, i) => {
  await admin!.from("user_profiles").update({ theme: "light" }).eq("id", userId);
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await page.goto("/connections");
  const clipped = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("a span.line-clamp-2, div span.line-clamp-2")]
      .filter((el) => el.scrollHeight > el.clientHeight + 1)
      .map((el) => el.textContent),
  );
  report.clippedDescriptions = clipped;
  expect(clipped).toEqual([]);
  await page.screenshot({ path: i.outputPath("hub.png") });
  await page.goto("/connections/microsoft");
  const connect = page.getByRole("button", { name: /Conectar/ }).first();
  if (await connect.isVisible()) {
    const box = (await connect.boundingBox())!;
    const fits = await connect.evaluate((el) => el.scrollWidth <= el.clientWidth);
    report.microsoftButton = { width: box.width, fits };
    expect(fits).toBe(true);
  }
  await page.screenshot({ path: i.outputPath("microsoft-detail.png") });
});

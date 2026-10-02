import { expect, test } from "@playwright/test";

/** Checks that need no account and no provider: they run in CI without secrets. */

test("sends security headers, with the microphone allowed only for ELISE", async ({ request }) => {
  const res = await request.get("/login");
  const h = res.headers();
  expect(h["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(h["content-security-policy"]).toContain("object-src 'none'");
  expect(h["x-frame-options"]).toBe("DENY");
  expect(h["x-content-type-options"]).toBe("nosniff");
  expect(h["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  expect(h["permissions-policy"]).toContain("microphone=(self)");
  expect(h["x-powered-by"]).toBeUndefined();
});

test("health reports states only, never values", async ({ request }) => {
  const res = await request.get("/api/health");
  expect([200, 503]).toContain(res.status());
  const body = await res.json();
  expect(body.checks).toHaveProperty("database");
  expect(body.checks).toHaveProperty("ai");
  // Only enum states: no keys, URLs or tokens.
  for (const v of Object.values(body.checks as Record<string, string>))
    expect(["ready", "not_configured", "down"]).toContain(v);
  expect(JSON.stringify(body)).not.toMatch(/sk-|sb_|tr_|https?:\/\//);
});

test("anonymous visitors are sent to sign in", async ({ page }) => {
  await page.goto("/my-elise/tasks");
  await expect(page).toHaveURL(/\/login/);
});

test("the sign-in page fits the screen and works with the keyboard", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByRole("button").first()).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
  // Tab reaches an interactive control (no keyboard trap on load).
  await page.keyboard.press("Tab");
  const tag = await page.evaluate(() => document.activeElement?.tagName);
  expect(["A", "BUTTON", "INPUT"]).toContain(tag);
});

for (const scheme of ["light", "dark"] as const)
  test(`the sign-in page renders in ${scheme} mode with a themed background`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto("/login");
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(bg).not.toBe("rgba(0, 0, 0, 0)");
  });

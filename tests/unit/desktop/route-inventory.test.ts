import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import { APP_ROUTES, VIEW_ONLY_ROUTES } from "@/core/platform/app-routes";

/**
 * Every ELISE screen opens inside ELISE Desktop (ADR-092). This keeps the one route list, the
 * web's pages, the loaders ELISE Cloud runs for Desktop and the views Desktop renders in step —
 * a new page can't ship web-only by accident, and the "opens in the browser" screen can't
 * come back.
 */
const ROOT = join(__dirname, "../../..");
const APP = join(ROOT, "src/app/(app)");
const SPECIAL = new Set(["/", "/my-elise/home"]); // dedicated Desktop routes
const DESKTOP_ONLY = new Set(["/settings/desktop"]); // no web page
const dirOf = (route: string) =>
  route === "/onboarding" ? join(ROOT, "src/app/onboarding") : join(APP, route);
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const registryKeys = (text: string) =>
  [...text.matchAll(/^\s+"(\/[^"]*)":/gm)].map((m) => m[1]!).sort();

const loaders = read("src/app/(app)/route-loaders.ts");
const views = read("desktop/src/renderer/route-views.ts");
const routed = APP_ROUTES.filter((r) => !SPECIAL.has(r));

function pages(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return pages(p);
    return name === "page.tsx" ? [p] : [];
  });
}

describe("route inventory", () => {
  it("every web page is a known ELISE route (nothing ships web-only)", () => {
    const routes = new Set<string>(APP_ROUTES);
    const found = pages(APP).map(
      (p) =>
        "/" +
        relative(APP, p)
          .replaceAll("\\", "/")
          .replace(/\/?page\.tsx$/, ""),
    );
    const unknown = found
      .map((r) => (r === "/" ? "/" : r.replace(/\/$/, "")))
      .filter((r) => !routes.has(r));
    expect(unknown).toEqual([]);
  });

  it("each web route has a view, and a loader exactly when it isn't view-only", () => {
    for (const route of routed.filter((r) => !DESKTOP_ONLY.has(r))) {
      const dir = dirOf(route);
      expect(existsSync(join(dir, "view.tsx")), `${route}: view.tsx`).toBe(true);
      expect(existsSync(join(dir, "load.ts")), `${route}: load.ts ⇔ not view-only`).toBe(
        !VIEW_ONLY_ROUTES.has(route),
      );
    }
  });

  it("the Cloud loaders and Desktop's views cover exactly the routed screens", () => {
    expect(registryKeys(loaders)).toEqual(routed.filter((r) => !VIEW_ONLY_ROUTES.has(r)).sort());
    expect(registryKeys(views)).toEqual([...routed].sort());
  });

  it("views import nothing server-only (they run in Desktop's local renderer)", () => {
    const forbidden =
      /from "(@\/application|@\/infrastructure|next\/headers|next\/server|server-only|@\/lib\/i18n\/server|@\/config\/)/;
    const offenders = routed
      .filter((r) => !DESKTOP_ONLY.has(r))
      .filter((r) => forbidden.test(readFileSync(join(dirOf(r), "view.tsx"), "utf8")));
    expect(offenders).toEqual([]);
  });

  it("every Server Action module the screens use is callable from Desktop", () => {
    // Deliberately absent: sign-in (Desktop's own override) and approving a Desktop sign-in
    // (the browser's page, /desktop/connect).
    const exempt = new Set(["features/auth/actions", "features/desktop/actions"]);
    const rpc = read("src/app/api/desktop/rpc/route.ts");
    const modules: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(join(ROOT, dir))) {
        const rel = `${dir}/${name}`;
        if (statSync(join(ROOT, rel)).isDirectory()) walk(rel);
        else if (/\.tsx?$/.test(name) && /^\s*["']use server["']/.test(read(rel)))
          modules.push(rel.replace(/^src\//, "").replace(/\.tsx?$/, ""));
      }
    };
    walk("src/features");
    const missing = modules.filter((m) => !exempt.has(m) && !rpc.includes(`"${m}"`));
    expect(modules.length).toBeGreaterThan(10);
    expect(missing).toEqual([]);
  });

  it("Desktop never falls back to “this section opens in the browser”", () => {
    const renderer = ["app.tsx", "pages.tsx", "screens.tsx"].map((f) =>
      read(`desktop/src/renderer/${f}`),
    );
    expect(renderer.join("\n")).not.toMatch(/NotYet|desktop\.notYet/);
  });
});

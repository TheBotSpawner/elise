import { describe, expect, it, vi } from "vitest";

import type { AuthContext } from "@/application/auth-context";

/**
 * ADR-112: Mercado Libre's terms forbid robots and scraping (cl. 7.6). ELISE never reads its
 * pages — web.open, web.discover and web.research all go through this one gate.
 */
vi.mock("server-only", () => ({}));
const fetchPage = vi.fn();
vi.mock("@/infrastructure/web/fetcher", () => ({ fetchPage }));
const { webCapability } = await import("@/application/web-service");

describe("never reading Mercado Libre's pages", () => {
  it("refuses every Mercado Libre domain before any request, with the reason", async () => {
    const web = webCapability({ workspaceId: "ws", userId: "u" } as AuthContext);
    for (const url of [
      "https://articulo.mercadolibre.com.ar/MLA-1111111111-x",
      "https://listado.mercadolibre.com.ar/rm4-mini",
      "https://www.mercadolivre.com.br/p/MLB1",
    ])
      await expect(web.open(url)).rejects.toMatchObject({ details: { limitation: "blocked" } });
    expect(fetchPage).not.toHaveBeenCalled();
  });
});

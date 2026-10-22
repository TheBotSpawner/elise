"use server";

import { z } from "zod";

import { requireAuthContext } from "@/application/auth-context";
import { runUserTool } from "@/application/elise";
import { shoppingCapability } from "@/application/shopping-service";
import { toPublicError, type PublicError } from "@/core/errors";
import type { LinkedLine } from "@/core/shopping/model";
import type { SurfacePayloads } from "@/core/workspace/registry";

/**
 * Listas' "Comparar precios" (ADR-111): the same shopping.* tools ELISE uses in chat and voice,
 * run as the person — so the button and "comparame mi lista" give the same result.
 */

export type ShoppingResult<T> = { ok: true; value: T } | { ok: false; error: PublicError };

export interface ShoppingToolResult {
  /** What the tool said (needsRegion, available: false, …). */
  output: Record<string, unknown>;
  payload: SurfacePayloads["shopping"] | null;
}

async function run<T>(fn: () => Promise<T>): Promise<ShoppingResult<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    return { ok: false, error: toPublicError(error) };
  }
}

async function tool(name: string, args: unknown): Promise<ShoppingToolResult> {
  const outcome = await runUserTool(await requireAuthContext(), name, args);
  const display = outcome.display;
  return {
    output: (outcome.output ?? {}) as Record<string, unknown>,
    payload: display?.kind === "shopping" ? display.shopping : null,
  };
}

export async function compareListAction(listId: string) {
  return run(() => tool("shopping.compare", { list: z.uuid().parse(listId) }));
}

export async function findProductsAction(query: string) {
  return run(() =>
    tool("shopping.findProduct", { query: z.string().trim().min(2).max(120).parse(query) }),
  );
}

export async function setShoppingRegionAction(region: string) {
  return run(() =>
    tool("shopping.setRegion", {
      place: z
        .string()
        .regex(/^AR-[A-Z]$/)
        .parse(region),
    }),
  );
}

export async function linkItemAction(
  listId: string,
  item: { id: string; content: string },
  ean: string,
  quantity: number,
) {
  return run(() =>
    tool("shopping.linkItem", {
      list: z.uuid().parse(listId),
      item: item.content.slice(0, 500),
      itemId: z.uuid().parse(item.id),
      ean,
      quantity,
    }),
  );
}

/** The list's open items and the product each is linked to (read through RLS). */
export async function listLinesAction(listId: string) {
  return run(async (): Promise<{ lines: LinkedLine[]; region: string | null }> => {
    const s = shoppingCapability(await requireAuthContext());
    const [lines, region] = await Promise.all([s.listLines(z.uuid().parse(listId)), s.region()]);
    return { lines, region };
  });
}

export async function unlinkItemAction(itemId: string) {
  return run(async () =>
    shoppingCapability(await requireAuthContext()).unlink(z.uuid().parse(itemId)),
  );
}

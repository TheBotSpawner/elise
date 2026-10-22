import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

import { asUser, createTestDatabase, createUser } from "./db-harness";

/**
 * ADR-111 (migration 064): public prices are readable by members and written only by the
 * ingestion; a list item's product and a price alert are their owner's, never another
 * workspace's or person's.
 */
let db: PGlite;
let alice: { userId: string; workspaceId: string };
let bob: { userId: string; workspaceId: string };
let aliceItem: string;
const EAN = "7790742656018";

beforeAll(async () => {
  db = await createTestDatabase();
  alice = await createUser(db, "alice-shop@example.com");
  bob = await createUser(db, "bob-shop@example.com");
  await db.query(
    "insert into public.shopping_products (ean, name, search, last_seen) values ($1, 'LECHE ENTERA 1 L', 'leche entera 1 l', '2026-10-22')",
    [EAN],
  );
  const list = await db.query<{ id: string }>(
    "insert into public.lists (workspace_id, name) values ($1, 'Compras') returning id",
    [alice.workspaceId],
  );
  aliceItem = (
    await db.query<{ id: string }>(
      "insert into public.list_items (workspace_id, list_id, content, position) values ($1, $2, '2 leches', 1) returning id",
      [alice.workspaceId, list.rows[0]!.id],
    )
  ).rows[0]!.id;
}, 60_000);

const link = (u: typeof alice, workspaceId = u.workspaceId) =>
  asUser(db, u.userId, () =>
    db.query(
      "insert into public.list_item_products (list_item_id, workspace_id, ean, match_method) values ($1, $2, $3, 'confirmed')",
      [aliceItem, workspaceId, EAN],
    ),
  );

describe("shopping data", () => {
  it("the public catalog is readable by members, never writable by them", async () => {
    const r = await asUser(db, bob.userId, () =>
      db.query("select ean from public.shopping_products"),
    );
    expect(r.rows).toHaveLength(1);
    await expect(
      asUser(db, bob.userId, () =>
        db.query(
          "insert into public.shopping_products (ean, name, search, last_seen) values ('7790000000003', 'FAKE', 'fake', '2026-10-22')",
        ),
      ),
    ).rejects.toThrow();
  });

  it("only the item's workspace can link it to a product", async () => {
    await expect(link(bob)).rejects.toThrow();
    // Claiming Alice's item under Bob's own workspace doesn't work either.
    await expect(link(bob, bob.workspaceId)).rejects.toThrow();
    await link(alice);
    const seen = await asUser(db, bob.userId, () =>
      db.query("select * from public.list_item_products"),
    );
    expect(seen.rows).toHaveLength(0);
    // A fabricated code is refused by the schema.
    await expect(
      asUser(db, alice.userId, () =>
        db.query("update public.list_item_products set ean = 'abc' where list_item_id = $1", [
          aliceItem,
        ]),
      ),
    ).rejects.toThrow();
  });

  it("price alerts belong to one person", async () => {
    await asUser(db, alice.userId, () =>
      db.query(
        "insert into public.shopping_price_alerts (workspace_id, user_id, ean, product_name, region, threshold_cents) values ($1, $2, $3, 'Leche', 'AR-C', 100000)",
        [alice.workspaceId, alice.userId, EAN],
      ),
    );
    const theirs = await asUser(db, bob.userId, () =>
      db.query("select * from public.shopping_price_alerts"),
    );
    expect(theirs.rows).toHaveLength(0);
    await expect(
      asUser(db, bob.userId, () =>
        db.query(
          "insert into public.shopping_price_alerts (workspace_id, user_id, ean, product_name, region, threshold_cents) values ($1, $2, $3, 'Leche', 'AR-C', 100000)",
          [alice.workspaceId, alice.userId, EAN],
        ),
      ),
    ).rejects.toThrow();
  });
});

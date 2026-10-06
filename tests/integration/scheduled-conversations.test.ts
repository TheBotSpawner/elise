import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

import { asUser, createTestDatabase, createUser } from "./db-harness";

/** Schedule → Run → Conversation (ADR-041), at the database. */

let db: PGlite;
let ana: { userId: string; workspaceId: string };
let ben: { userId: string; workspaceId: string };

beforeAll(async () => {
  db = await createTestDatabase();
  ana = await createUser(db, "ana@example.com");
  ben = await createUser(db, "ben@example.com");
}, 60_000);

async function scheduleAndRun(owner: { userId: string; workspaceId: string }, at: string) {
  const schedule = (
    await asUser(db, owner.userId, () =>
      db.query<{ id: string }>(
        `insert into public.schedules
           (workspace_id, created_by_user_id, name, schedule_type, timezone, schedule_definition, action_type, next_run_at)
         values ($1, $2, 'Morning Brief', 'recurring', 'UTC',
                 '{"kind":"weekly","days":[1],"time":"08:00"}', 'morning_brief', now())
         returning id`,
        [owner.workspaceId, owner.userId],
      ),
    )
  ).rows[0]!.id;
  const run = (
    await db.query<{ id: string }>(
      `insert into public.schedule_runs (workspace_id, schedule_id, trigger, status, scheduled_for)
       values ($1, $2, 'scheduled', 'completed', $3) returning id`,
      [owner.workspaceId, schedule, at],
    )
  ).rows[0]!.id;
  return { schedule, run };
}

const conversation = (
  owner: { userId: string; workspaceId: string },
  link: { schedule: string; run: string },
) =>
  asUser(db, owner.userId, () =>
    db.query<{ id: string; origin: string }>(
      `insert into public.conversations (workspace_id, user_id, title, origin, schedule_id, schedule_run_id)
       values ($1, $2, 'Morning Brief — 5 oct', 'scheduled', $3, $4) returning id, origin`,
      [owner.workspaceId, owner.userId, link.schedule, link.run],
    ),
  );

describe("scheduled conversations", () => {
  it("a run opens one conversation, linked from its result", async () => {
    const link = await scheduleAndRun(ana, "2026-10-05T08:00:00Z");
    const { rows } = await conversation(ana, link);
    expect(rows[0]!.origin).toBe("scheduled");
    await expect(conversation(ana, link)).rejects.toThrow(/conversations_schedule_run_idx/);
    const result = await db.query<{ conversation_id: string }>(
      `insert into public.scheduled_results (workspace_id, user_id, schedule_id, schedule_run_id, result_type, title, content, conversation_id)
       values ($1, $2, $3, $4, 'morning_brief', 'Morning Brief', '{}', $5) returning conversation_id`,
      [ana.workspaceId, ana.userId, link.schedule, link.run, rows[0]!.id],
    );
    expect(result.rows[0]!.conversation_id).toBe(rows[0]!.id);
  });

  it("is an ordinary conversation: messages and the Live Workspace attach to it, private to its author", async () => {
    const link = await scheduleAndRun(ana, "2026-10-06T08:00:00Z");
    const id = (await conversation(ana, link)).rows[0]!.id;
    await asUser(db, ana.userId, () =>
      db.query(
        `insert into public.messages (conversation_id, workspace_id, role, content) values ($1, $2, 'user', 'Contame más sobre ese mail')`,
        [id, ana.workspaceId],
      ),
    );
    const own = await asUser(db, ana.userId, () =>
      db.query("select id from public.conversations where id = $1", [id]),
    );
    expect(own.rows).toHaveLength(1);
    const other = await asUser(db, ben.userId, () =>
      db.query("select id from public.conversations where id = $1", [id]),
    );
    expect(other.rows).toHaveLength(0);
  });

  it("can't point at another workspace's schedule or run", async () => {
    const anas = await scheduleAndRun(ana, "2026-10-07T08:00:00Z");
    await expect(conversation(ben, anas)).rejects.toThrow(/same workspace/);
  });

  it("existing conversations stay what they were (origin user, no links)", async () => {
    const { rows } = await asUser(db, ana.userId, () =>
      db.query<{ origin: string; schedule_run_id: string | null }>(
        `insert into public.conversations (workspace_id, user_id, title) values ($1, $2, 'Hola') returning origin, schedule_run_id`,
        [ana.workspaceId, ana.userId],
      ),
    );
    expect(rows[0]).toEqual({ origin: "user", schedule_run_id: null });
  });
});

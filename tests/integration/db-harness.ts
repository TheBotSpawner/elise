import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";

/**
 * In-process Postgres (PGlite) with the minimal Supabase surface our migrations rely on:
 * roles, auth.users, auth.uid() and the realtime publication. Lets RLS be tested for real
 * without Docker or a hosted project.
 */
const SUPABASE_STUB = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  create schema auth;
  create table auth.users (
    id uuid primary key,
    email text,
    raw_user_meta_data jsonb default '{}'::jsonb
  );
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
  grant usage on schema auth to authenticated, anon;
  create publication supabase_realtime;
  -- Supabase keeps extensions (pgvector) in their own schema, and Storage buckets in storage.
  create schema extensions;
  grant usage on schema extensions to authenticated, anon, service_role;
  create schema storage;
  create table storage.buckets (
    id text primary key,
    name text not null,
    public boolean default false,
    file_size_limit bigint,
    allowed_mime_types text[]
  );
  -- Supabase's default privileges: API roles get table access, RLS restricts rows.
  -- Migrations can still revoke (e.g. connection_secrets).
  grant usage on schema public to authenticated, anon, service_role;
  alter default privileges in schema public grant all on tables to authenticated, anon, service_role;
  alter default privileges in schema public grant execute on functions to authenticated, anon, service_role;
`;

const MIGRATIONS_DIR = join(process.cwd(), "supabase", "migrations");

export async function createTestDatabase(): Promise<PGlite> {
  const db = new PGlite({ extensions: { vector } });
  await db.exec(SUPABASE_STUB);
  for (const file of readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    await db.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
  }
  return db;
}

export async function createUser(
  db: PGlite,
  email: string,
  meta: Record<string, string> = {},
): Promise<{ userId: string; workspaceId: string }> {
  const userId = crypto.randomUUID();
  await db.query("insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)", [
    userId,
    email,
    JSON.stringify(meta),
  ]);
  const ws = await db.query<{ workspace_id: string }>(
    "select workspace_id from public.workspace_members where user_id = $1",
    [userId],
  );
  return { userId, workspaceId: ws.rows[0]!.workspace_id };
}

/** Runs `fn` as an authenticated API user, exactly as PostgREST would (RLS enforced). */
export async function asUser<T>(db: PGlite, userId: string, fn: () => Promise<T>): Promise<T> {
  await db.exec(`set role authenticated`);
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [userId]);
  try {
    return await fn();
  } finally {
    await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false);`);
  }
}

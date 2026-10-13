-- ADR-053 Habits v2. Icons and pause ends live in habits.metadata (no new columns); this
-- migration only lets members delete a habit for good (its check-ins cascade). Archive stays
-- the default, reversible way out.
grant delete on public.habits to authenticated;

create policy "Members delete habits" on public.habits for delete to authenticated
  using (public.is_workspace_member(workspace_id));

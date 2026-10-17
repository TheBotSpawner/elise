-- Deleting a finance category (ADR-075). One DELETE is atomic through the existing FKs:
-- finance_transactions.category_id → set null (movements are kept, uncategorized),
-- finance_categories.parent_category_id → set null, finance_budgets.category_id → cascade.
-- Workspace members only, like the other category policies.
create policy "Members delete finance categories" on public.finance_categories for delete to authenticated
  using (public.is_workspace_member(workspace_id));

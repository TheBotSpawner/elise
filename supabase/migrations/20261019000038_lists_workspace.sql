-- ADR-051: Lists workspace — column order, icon, per-list item sort, completion time and labels
-- for list items. Additive and backward-compatible: no list or item is recreated, no id or
-- checked state changes. Requires 037 (the shared `labels` / `label_assignments`).

alter table public.lists
  add column position double precision,
  add column icon text check (char_length(icon) <= 16),
  add column item_sort text not null default 'manual' check (item_sort in ('manual', 'alpha', 'recent'));

-- A stable column order for existing lists: their creation order, per workspace.
update public.lists l
   set position = o.rn * 1024
  from (
    select id, row_number() over (partition by workspace_id order by created_at, id) as rn
      from public.lists
  ) o
 where o.id = l.id;

create index lists_order_idx on public.lists (workspace_id, position) where archived_at is null;

-- When an item was checked (completed items are listed most recent first). Existing checked
-- items get their last update as a best estimate.
alter table public.list_items add column checked_at timestamptz;
update public.list_items set checked_at = updated_at where checked and checked_at is null;

-- List items join the one label system (Lists and Tasks stay separate domains).
alter table public.label_assignments
  add column list_item_id uuid references public.list_items (id) on delete cascade;
alter table public.label_assignments drop constraint label_target;
alter table public.label_assignments
  add constraint label_target check (num_nonnulls(task_id, enrichment_id, list_item_id) = 1);
create unique index label_assignments_list_item_idx
  on public.label_assignments (label_id, list_item_id) where list_item_id is not null;

drop policy "Members manage task label assignments" on public.label_assignments;
create policy "Members manage label assignments" on public.label_assignments
  for all to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (
    public.is_workspace_member(workspace_id)
    and exists (
      select 1 from public.labels l
       where l.id = label_id and l.workspace_id = label_assignments.workspace_id
    )
    and (task_id is null or exists (
      select 1 from public.tasks t
       where t.id = task_id and t.workspace_id = label_assignments.workspace_id
    ))
    and (enrichment_id is null or exists (
      select 1 from public.task_enrichments e
       where e.id = enrichment_id and e.workspace_id = label_assignments.workspace_id
    ))
    and (list_item_id is null or exists (
      select 1 from public.list_items i
       where i.id = list_item_id and i.workspace_id = label_assignments.workspace_id
    ))
  );

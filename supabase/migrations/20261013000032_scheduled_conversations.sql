-- Scheduled conversations (ADR-041): a scheduled run is an ELISE-initiated conversation. The run
-- opens a normal conversation (same messages, same Live Canvas); its result points to it.
-- Additive only: older results keep their stored content and open through the fallback view.

alter table public.conversations
  add column origin text not null default 'user' check (origin in ('user', 'scheduled')),
  add column schedule_id uuid references public.schedules (id) on delete set null,
  add column schedule_run_id uuid references public.schedule_runs (id) on delete set null;

-- One conversation per run: a retried run reopens the same one.
create unique index conversations_schedule_run_idx on public.conversations (schedule_run_id)
  where schedule_run_id is not null;

alter table public.scheduled_results
  add column conversation_id uuid references public.conversations (id) on delete set null;

-- A scheduled conversation and its run must belong to the conversation's workspace.
create or replace function public.check_scheduled_conversation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.schedule_run_id is not null and not exists (
    select 1 from public.schedule_runs r
    where r.id = new.schedule_run_id and r.workspace_id = new.workspace_id
  ) then
    raise exception 'schedule run must belong to the same workspace';
  end if;
  if new.schedule_id is not null and not exists (
    select 1 from public.schedules s
    where s.id = new.schedule_id and s.workspace_id = new.workspace_id
  ) then
    raise exception 'schedule must belong to the same workspace';
  end if;
  return new;
end;
$$;

create trigger conversations_scheduled_check
  before insert or update of schedule_id, schedule_run_id on public.conversations
  for each row execute function public.check_scheduled_conversation();

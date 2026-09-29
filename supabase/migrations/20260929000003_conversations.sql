-- Conversations, messages and AI run tracing. Conversations are private to their author,
-- even inside a shared workspace.

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  title text check (char_length(title) <= 200),
  status text not null default 'active' check (status in ('active', 'archived')),
  last_message_at timestamptz not null default now(),
  active_context jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);

create index conversations_recent_idx
  on public.conversations (workspace_id, user_id, last_message_at desc) where archived_at is null;

create table public.ai_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  conversation_id uuid references public.conversations (id) on delete set null,
  ai_provider text not null,
  model_key text not null,
  skill_key text not null default 'default',
  status text not null default 'running' check (status in ('running', 'completed', 'failed', 'cancelled')),
  request_id text,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  latency_ms integer,
  token_usage jsonb not null default '{}'::jsonb,
  tool_call_count integer not null default 0,
  error_code text,
  created_at timestamptz not null default now()
);

create index ai_runs_user_recent_idx on public.ai_runs (user_id, started_at desc);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'system_internal', 'tool_summary')),
  content text not null check (char_length(content) <= 32000),
  content_format text not null default 'markdown' check (content_format in ('markdown', 'text')),
  run_id uuid references public.ai_runs (id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index messages_conversation_idx on public.messages (conversation_id, created_at);

create trigger conversations_updated_at before update on public.conversations
  for each row execute function public.set_updated_at();

alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.ai_runs enable row level security;

create policy "Authors manage their conversations" on public.conversations
  for all to authenticated
  using (user_id = auth.uid() and public.is_workspace_member(workspace_id))
  with check (user_id = auth.uid() and public.is_workspace_member(workspace_id));

create policy "Authors read their messages" on public.messages
  for select to authenticated
  using (
    public.is_workspace_member(workspace_id)
    and exists (
      select 1 from public.conversations c
      where c.id = conversation_id and c.user_id = auth.uid() and c.workspace_id = messages.workspace_id
    )
  );
create policy "Authors add messages" on public.messages
  for insert to authenticated
  with check (
    public.is_workspace_member(workspace_id)
    and exists (
      select 1 from public.conversations c
      where c.id = conversation_id and c.user_id = auth.uid() and c.workspace_id = messages.workspace_id
    )
  );

create policy "Users read their AI runs" on public.ai_runs
  for select to authenticated using (user_id = auth.uid() and public.is_workspace_member(workspace_id));
create policy "Users record their AI runs" on public.ai_runs
  for insert to authenticated with check (user_id = auth.uid() and public.is_workspace_member(workspace_id));
create policy "Users finish their AI runs" on public.ai_runs
  for update to authenticated
  using (user_id = auth.uid() and public.is_workspace_member(workspace_id))
  with check (user_id = auth.uid() and public.is_workspace_member(workspace_id));

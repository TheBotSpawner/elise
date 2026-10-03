-- ADR-031: chat attachments — files the user gives one message. Not Knowledge: nothing here is
-- indexed or kept beyond the conversation it was sent in.
-- Staged (uploading/ready) rows belong to an unsent draft; `sent` rows belong to one user turn.
create table public.chat_attachments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  conversation_id uuid references public.conversations (id) on delete cascade,
  session_id uuid references public.interaction_sessions (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 255),
  mime_type text not null,
  size_bytes bigint not null check (size_bytes > 0),
  storage_path text not null unique,
  status text not null default 'uploading' check (status in ('uploading', 'ready', 'sent')),
  created_at timestamptz not null default now(),
  sent_at timestamptz
);

create index chat_attachments_staged_idx on public.chat_attachments (user_id, created_at)
  where status <> 'sent';

alter table public.chat_attachments enable row level security;

-- Only the author sees and manages their attachments (a draft is personal, even in a team).
create policy "Authors read attachments" on public.chat_attachments
  for select to authenticated
  using (user_id = auth.uid() and public.is_workspace_member(workspace_id));
create policy "Authors stage attachments" on public.chat_attachments
  for insert to authenticated
  with check (user_id = auth.uid() and public.is_workspace_member(workspace_id));
create policy "Authors update attachments" on public.chat_attachments
  for update to authenticated
  using (user_id = auth.uid() and public.is_workspace_member(workspace_id))
  with check (user_id = auth.uid() and public.is_workspace_member(workspace_id));
create policy "Authors remove attachments" on public.chat_attachments
  for delete to authenticated
  using (user_id = auth.uid() and status <> 'sent');

-- Private bucket; paths are workspace/{workspace_id}/chat/{attachment_id}/{file}. No API
-- policies: the server issues one-time signed upload URLs and reads files itself.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'chat-attachments',
  'chat-attachments',
  false,
  20971520,
  array[
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'text/plain',
    'text/markdown',
    'text/csv',
    'image/png',
    'image/jpeg',
    'image/webp',
    'image/gif',
    'application/octet-stream'
  ]
)
on conflict (id) do nothing;

-- ADR-035: one document extraction (native text first, OCR only for the pages that need it),
-- shared by Knowledge ingestion and chat attachments.

-- What a file says, by its bytes: reused when the same file is read again (attached in chat,
-- then saved to Knowledge) and resumed page by page if OCR stops midway. Derived data only:
-- the original stays in Storage. Different versions have different bytes, so never collide.
create table public.document_extractions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  -- SHA-256 of the file's bytes.
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  mime_type text not null,
  method text not null check (method in ('native', 'ocr', 'hybrid')),
  page_count integer not null default 0 check (page_count >= 0),
  -- [{ "page": 1, "text": "…", "method": "native" | "ocr" }]
  pages jsonb not null default '[]'::jsonb check (jsonb_typeof(pages) = 'array'),
  ocr_provider text,
  ocr_pages integer not null default 0 check (ocr_pages >= 0),
  -- False while OCR is still going (a retry continues from the pages already read).
  complete boolean not null default false,
  warnings jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, content_hash)
);

alter table public.document_extractions enable row level security;
-- Members may read their workspace's extractions; only the server writes them.
create policy "Members read extractions" on public.document_extractions
  for select to authenticated using (public.is_workspace_member(workspace_id));

drop trigger if exists document_extractions_updated_at on public.document_extractions;
create trigger document_extractions_updated_at before update on public.document_extractions
  for each row execute function public.set_updated_at();

-- OCR is a paid provider call, recorded per page like other usage. Never the text.
alter table public.usage_events drop constraint if exists usage_events_operation_check;
alter table public.usage_events add constraint usage_events_operation_check check (
  operation in ('llm', 'embedding', 'transcription', 'speech', 'web_search', 'web_fetch', 'maps', 'ocr')
);

-- A chat image saved to Knowledge keeps its original (its text comes from OCR).
update storage.buckets
set allowed_mime_types = array[
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
where id = 'knowledge-originals';

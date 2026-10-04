-- ADR-036: Knowledge ingestion reliability and multi-format documents.

-- A worker's last sign of life. Started work that stops beating is stalled (the lease),
-- instead of waiting a fixed half hour; queued work is measured from when it was queued.
alter table public.knowledge_sync_runs add column if not exists heartbeat_at timestamptz;
alter table public.knowledge_versions add column if not exists heartbeat_at timestamptz;

-- The watchdog looks for the newest heartbeat per workspace (is the runtime moving at all?).
create index if not exists knowledge_versions_heartbeat_idx
  on public.knowledge_versions (workspace_id, heartbeat_at desc)
  where heartbeat_at is not null;

-- The extractor registry's formats: HTML, XLSX, PPTX (and TIFF scans) as Knowledge originals…
update storage.buckets
set allowed_mime_types = array[
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain',
  'text/markdown',
  'text/csv',
  'text/html',
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/tiff',
  'application/octet-stream'
]
where id = 'knowledge-originals';

-- …and as chat attachments (same extractors, ADR-031 parity).
update storage.buckets
set allowed_mime_types = array[
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain',
  'text/markdown',
  'text/csv',
  'text/html',
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'application/octet-stream'
]
where id = 'chat-attachments';

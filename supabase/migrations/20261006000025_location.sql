-- Location (ADR-023): places, addresses and travel, from a server-side maps provider.
insert into public.capability_definitions (key, display_name, status) values
  ('location', 'Location', 'available')
on conflict (key) do update set status = 'available';

-- Maps calls (places, geocoding, routes) are paid provider calls, recorded in usage_events like
-- web searches. Metadata only: never the places asked for, addresses or coordinates.
alter table public.usage_events drop constraint if exists usage_events_operation_check;
alter table public.usage_events add constraint usage_events_operation_check check (
  operation in ('llm', 'embedding', 'transcription', 'speech', 'web_search', 'web_fetch', 'maps')
);

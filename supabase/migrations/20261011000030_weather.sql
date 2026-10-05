-- Weather (ADR-038): current conditions and forecasts from a server-side provider. Internal and
-- read-only like Location: no user connection, no stored places or coordinates.
insert into public.capability_definitions (key, display_name, status) values
  ('weather', 'Weather', 'available')
on conflict (key) do update set status = 'available';

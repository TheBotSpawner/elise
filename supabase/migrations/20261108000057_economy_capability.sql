-- Public economic data (ADR-094): Argentina's dollar, inflation, holidays and deposit rates,
-- server-provided (DolarApi, ArgentinaDatos), read-only like Weather and Markets: no user
-- connection, nothing stored per user. Its tools only read, so they work before this runs; the
-- catalog row keeps the code and database registries in step.
insert into public.capability_definitions (key, display_name, status) values
  ('economy', 'Economic data', 'available')
on conflict (key) do update set status = 'available';

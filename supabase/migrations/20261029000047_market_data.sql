-- Market data (ADR-074): public quotes and history, server-provided (FMP), read-only like Weather:
-- no user connection, nothing stored beyond each person's followed symbols (user_preferences).
insert into public.capability_definitions (key, display_name, status) values
  ('markets', 'Market data', 'available')
on conflict (key) do update set status = 'available';

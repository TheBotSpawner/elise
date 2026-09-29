-- Email becomes available through Gmail on existing Google connections (incremental scope).
-- Grants live in connection_capabilities per connection; nothing else changes shape.
update public.capability_definitions set status = 'available' where key = 'email';

-- ADR-103: a device the home engine finds on the network is not one of the person's devices
-- until they add it. Integrations such as Google Cast add every other device of their kind on the
-- network by themselves; those now wait under "Encontrados en tu red" instead of joining
-- "Mis dispositivos", voice control and modes.
--
-- Additive: every device already listed stays listed (added when it was created). New rows are
-- added only by the person (Hogar's "Agregar", or the device they just added through a setup).

alter table public.home_devices add column if not exists added_at timestamptz;

update public.home_devices set added_at = created_at where added_at is null;

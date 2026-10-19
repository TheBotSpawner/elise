-- ELISE Home runtime in Desktop presence (ADR-082): while a computer prepares ELISE Home, the
-- web shows real progress ("Preparando ELISE Home en PC de casa… 42%") and advances by itself.
-- Additive only; RLS from migration 050 still applies (each person sees their own rows).

alter table public.desktop_installations
  add column home_enabled boolean not null default false,
  add column home_runtime_phase text check (
    home_runtime_phase is null or home_runtime_phase in (
      'not_installed', 'checking_requirements', 'requirements_missing', 'restart_required',
      'downloading', 'verifying', 'installing', 'starting', 'ready', 'degraded', 'stopped',
      'updating', 'error'
    )
  ),
  add column home_runtime_progress smallint check (
    home_runtime_progress is null or home_runtime_progress between 0 and 100
  );

-- The open Hogar page hears a Desktop come online or move through setup without refreshing.
alter publication supabase_realtime add table public.desktop_installations;

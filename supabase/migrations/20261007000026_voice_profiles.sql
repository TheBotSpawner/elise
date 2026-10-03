-- ADR-030: curated ELISE voice profiles ("elise", "elise-alt", ElevenLabs) join the current
-- provider's voices. A profile id maps to a provider voice on the server; no provider ids here.
alter table public.user_profiles drop constraint if exists user_profiles_voice_name_check;
alter table public.user_profiles
  add constraint user_profiles_voice_name_check
  check (voice_name in ('marin', 'cedar', 'coral', 'sage', 'ash', 'verse', 'elise', 'elise-alt'));

-- ADR-104: continuous conversation is off unless the person turns it on. New accounts start
-- with it off on every device (it lives on the profile, so every device reads the same value).
--
-- Additive and non-destructive: existing rows keep their value. The column's old default (on)
-- can't be told apart from an explicit "on", so no stored choice is rewritten; onboarding
-- already set it off for anyone who didn't consent (ADR-068), and Settings › Voz changes it.

alter table public.user_profiles alter column voice_continuous set default false;

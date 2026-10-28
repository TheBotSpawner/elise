-- The study widget's question log (ADR-124): every question asked in a session, in order, with
-- its mark (correct / wrong / unanswered) — set by the evaluator, correctable by the user.
-- Bounded like `current`; the application never stores more than 50 entries.

alter table public.study_sessions
  add column if not exists log jsonb not null default '[]'::jsonb
    check (jsonb_typeof(log) = 'array' and octet_length(log::text) <= 60000);

-- Knowledge Space context (ADR-020 §9): what a Space or Section is about, in the user's own
-- words ("Análisis Matemático II, 2º año de Ingeniería en Sistemas; el parcial es en junio").
-- ELISE reads it as background when working in that Space. Additive.
alter table public.knowledge_spaces
  add column if not exists context text
    check (context is null or char_length(context) <= 4000);

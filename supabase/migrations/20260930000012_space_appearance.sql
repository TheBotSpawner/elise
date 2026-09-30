-- Knowledge Space appearance: a curated icon and a subtle accent color, chosen by the user.
-- Keys are validated by the application (src/core/knowledge/appearance.ts); null = default.
alter table public.knowledge_spaces
  add column icon text check (icon ~ '^[a-z-]{1,30}$'),
  add column color text check (color ~ '^[a-z]{1,20}$');

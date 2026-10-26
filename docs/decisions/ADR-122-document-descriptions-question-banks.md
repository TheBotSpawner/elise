# ADR-122: Document descriptions, title-aware search and question banks

**Status:** Accepted (2026-10-26). Extends ADR-007 (Knowledge search) and ADR-016 (Study).

## Context

Two real failures:
- **The document wasn't found.** Asked for "el cronograma de Análisis de Sistemas", search
  returned a general academic calendar. Search only read passage text. A document's name was
  never searched, so "cronograma" found nothing unless the passages repeated that word. Accents
  also had to match exactly: "analisis" did not find "análisis".
- **Exam questions were invented.** Asked for "las preguntas del EPI", Study wrote new
  questions about concepts. The user had uploaded two PDFs with the 100 real questions. Study
  always writes its own questions from concepts, so a list of exact exam questions was treated
  as just more theory.

The user also has no way to tell ELISE what a document is, or when to use it.

## Decision

1. **Descriptions.**
   - Any document in a Space can have a description: what it is and when it is useful, in the
     user's own words. It is stored in `knowledge_items.description` (at most 1000 characters,
     migration 068) and set with "Describir" on the Space page.
   - It is user content, not instructions. The model sees it next to each cited passage
     (`documentDescription`) and in Space overviews.
2. **Search by name and description.** `search_knowledge_chunks` adds a third ranked list:
   - The list holds documents whose title or description shares the question's keywords.
     For each, it takes the passages closest to the question (the opening passages when there
     are no embeddings).
   - It is fused with the semantic and keyword lists like the other two (RRF).
   - These hits count as keyword matches, so they are evidence.
3. **Accents.** Every keyword is also searched without accents.
4. **Question banks in Study.**
   - A document is a question bank when its name or description says so: consignas, preguntas,
     cuestionario, ejercicios, simulacro, modelo de examen, questions.
   - When the subject's material has one and no unit or topic was asked for, a session asks the
     bank's numbered questions exactly as written, never repeating one in the session.
     `study.start` takes `fromQuestionBank`:
     - true: always use a bank. A document the user names counts as a bank.
     - false: write new questions instead.
     - Omitted: the automatic rule above.
   - The answer key comes from the whole material. If the material does not state the answer,
     the key is empty. The evaluator then says the material does not include the answer; it
     never invents one.
   - A bank that can't be read as numbered questions (fewer than 3) falls back to generated
     questions.

## Consequences

- Naming or describing a document is now the most reliable way to make ELISE find it.
- Until migration 068 is applied, descriptions are not read or saved. Search keeps working,
  without the name/description list: descriptions are read in a separate query that tolerates
  the missing column.
- Detecting a bank is a word heuristic. A file named "preguntas frecuentes" counts as one too.
  If it has no numbered questions, Study falls back to generated questions, so the cost is one
  extra read.

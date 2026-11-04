# ADR-134: Closing a conversation with a goodbye

**Status:** Accepted (2026-11-04). Extends ADR-102 (spoken stop).

## Context

The owner wants to end the listening with what people really say ("Gracias Elise", "Genial, gracias",
"Listo Elise", "Dale, genial"), only when it's followed by silence, never mid-sentence.

## Decision

1. **A goodbye is a whole utterance** made only of closing words (`session-control.ts`). An utterance
   ends after ADR-131's 2 s of silence, so that's the silence asked for: "gracias por avisarme" or
   "genial, mostrame mis tareas" aren't goodbyes.
2. **It needs a word that closes.** "Dale", "ok" or "bueno" alone don't.
3. **Never as an answer.** When her last reply ended in a question or waits for an approval, the
   words go to ELISE as usual ("¿Querés que abra alguno?" "Dale, genial").
4. **It ends quietly,** like ADR-102's stop.
5. **Not in a Live session:** it reads partial transcripts, with no finished utterance to check.

## Consequences

- Transcription models sometimes write "Gracias." for noise or silence. That would now close the
  conversation. Not measured; saying "Elise" reopens it.

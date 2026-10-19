# ADR-097: She doesn't talk over the song; "next" keeps the music going

**Status:** Accepted (2026-10-19). Extends ADR-042 and ADR-044 (music) and ADR-034 (spoken
acknowledgements).

## Context

Two things came up in real use:

- **She talked over the song.** "Reproducime Counting Stars" started the song, and a few seconds
  later ELISE said "Lo encontré…" over it. The spoken reply is synthesized after the tool result,
  so it arrives once the music has already started.
- **"Next" did nothing.** With one song requested, YouTube's "next" had nothing queued. It only
  showed "No hay más en la cola".

## Decision

1. **The song is the answer.** When music starts playing during a voice turn, whatever is left
   of that turn's spoken reply is dropped (`VoiceController.musicStarted`). The written reply
   stays on screen.
   - This applies to Inicio and to the floating voice Orb.
   - GPT-Live speaks its own reply. There it is not hushed yet: that needs a response cancel in
     the realtime session.
2. **"Next" with nothing queued plays YouTube's own mix of the song.** The mix is the playlist
   `RD<videoId>`, YouTube's own "up next", and it starts at its second item. From then on,
   next and previous move through the mix. The Surface shows each track's own title and channel.

## Consequences

- A confirmation spoken before the music starts (an acknowledgement) is still said.
- A YouTube mix depends on YouTube: a video without a mix shows the player's own error, and the
  usual recovery applies.

# ADR-085: YouTube channels as first-class media entities

**Status:** Accepted (2026-10-19). Builds on ADR-042/044.

## Context

"Reproducime un video aleatorio de Firbot Academy" failed after 11 steps of web and music
searches. Music tools only knew videos, artists and tracks; nothing could express "the latest"
or "a random one" from a channel. So the model searched the web to "confirm" the channel. The
speech slip "Firebot Academy" made it worse: YouTube's own search returns nothing for it.

## Decision

- **Resolution:** `music.channel` (action `find` / `latest` / `random` / `search`, always YouTube)
  resolves a channel through the official YouTube Data API, in a fixed order:
  1. A link, `@handle` or channel id → `channels.list` (1 unit).
  2. A name → handles it could have (1 unit each) plus YouTube's channel search (100 units).
  3. Only if nothing is close: the name with one letter dropped, tried as handles. A hit is
     kept only when it still scores ≥ 0.85 (marked `corrected`, and ELISE says the real name).
  4. Equal matches → a question listing title and @handle. Nothing → "No encontré un canal de
     YouTube que pueda confirmar", and ELISE asks for the @handle, link or spelling.

  A spelled name ("F-I-R-B-O-T") is collapsed before anything else and wins. Scoring uses title
  or handle similarity only; subscriber count never matters. Resolved channels are cached for
  6 hours per server instance (quota).
- **Videos:** from the channel's uploads playlist (1 unit per 50; up to 100 for random), or a
  search scoped by `channelId`. `videos.list` confirms every video is public, processed,
  embeddable and really from that channel; anything else is dropped.
  - "Último" is the newest regular upload: no Shorts (≤ 60 s or `#shorts`), live or upcoming
    streams, or private videos. A Short counts only if the channel has nothing else.
  - "Aleatorio" is a random playable regular video that isn't the one playing now.
- **Follow-ups:** the Music Surface remembers the channel (`channel`), so "otro de ese canal"
  works with no channel argument and no new search.
- **Routing:** "video", "videoclip" and "canal de YouTube" select the music tools. The guidance
  sends channels to `music.channel`, never to web search. Other YouTube requests stay on
  `music.play`, unchanged. "YouTube unreachable" is never reported as "channel not found".

## Consequences

Needs `YOUTUBE_API_KEY`, which already exists, server-side only. A channel resolution by name
costs about 100–110 quota units; by handle or link, about 3. Playback uses the existing embedded
player, so Web and Desktop behave the same.

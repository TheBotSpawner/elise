# ADR-044: YouTube playback reliability — finding is not playing

**Status:** Accepted (2026-10-05). Refines ADR-042 for the embedded YouTube provider. Spotify
and the overall Music architecture are unchanged.

## Context

"Reproducime One More Time de Daft Punk" failed with "No encontré…". When something did
resolve, ELISE said "está reproduciéndose" while no audio played. We reproduced it against the
real Data API. Every candidate, including "Daft Punk - One More Time (Official Video)", scored
the same 0.67, because generic word overlap counted the Spanish "de" as a missing word. The
`track`/`artist` kind filters then excluded every YouTube video, giving NOT_FOUND. The tool
also returned an optimistic `playing: true`, and the Surface animated progress while the
browser had blocked autoplay.

## Decision

1. **Music-specific resolution** (`core/capabilities/music-match.ts`, pure):
   - `parseMusicRequest` reads artist and track ("X de/by Y", "Y - X"), drops provider words
     and records which version the user asked for (live, karaoke, cover, remix…).
   - `scoreCandidate` favors track and artist coverage, the artist's own channel or Topic
     channel, VEVO, "Official Video" and "Official Audio". It penalizes covers, karaoke,
     reactions, slowed or sped-up uploads, remixes, live versions, tutorials, interviews and
     Shorts, unless the user asked for that version.
   - `PLAY_CONFIDENCE = 0.6`. Anything below it comes back as choices, never a silent guess.
2. **Bounded search.** At most three queries: "artist track", then "artist track official",
   then "track artist". Searches use `type=video`, `videoEmbeddable` and `videoSyndicated`.
   `videos.list` (1 unit) keeps only public, processed, embeddable videos and adds their
   duration. Each attempt logs `music.youtube.search`.
3. **Reuse.** A YouTube link (`url`) or a video already on screen plays directly with no new
   search. "En YouTube" routes to YouTube through the `provider` input; ELISE never switches
   provider silently.
4. **Truthful states.** The states are `idle | loading | ready | play_requested |
   autoplay_blocked | buffering | playing | paused | ended | error`.
   - `music.play` returns `play_requested`, `confirmed: false`, and instructions never to say
     it is playing.
   - Only the IFrame player's own events set `playing`. Progress and the equalizer move only
     in that state.
   - `onAutoplayBlocked`, plus a 3.5 s watchdog for browsers that refuse silently, sets
     `autoplay_blocked`. The Surface then shows one primary **Reproducir** button: a real tap,
     which unmutes and plays.
   - Player errors (2, 5, 100, 101, 150, 153) move to the next confident candidate, up to three.
     After that they show a sentence in plain words.
5. **One visible, persistent player.** A single IFrame player is created once and reused with
   `loadVideoById`, never destroyed between tracks.
   - It lives in a fixed frame that docks over the YouTube Surface's video slot (16:9, at least
     200×200) while that slot is on screen. Otherwise it floats in a corner.
   - It is never hidden while active. Closing it stops playback.
   - The iframe never moves in the DOM, because moving it would reload the player.

## Consequences

- An exact request costs at most 3 × (100 + 1) quota units, and usually 101.
- The model may say "Lo encontré… arrancando" quickly. "Está sonando" depends on the browser.
- Autoplay still depends on the browser's user-activation rules. ELISE does not work around
  them; it asks for one tap.
- Real-Chrome validation is pending: there was no automated browser in this environment.

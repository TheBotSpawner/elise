# ADR-042: Music, a canonical capability with provider adapters

**Status:** Accepted (2026-10-05). Builds on ADR-007 (capability/provider model), ADR-013/021
(Live Workspace), ADR-017 (voice), ADR-026 (GPT-Live) and ADR-040 (Methods). Migration
`20261014000033_music.sql`. Setup: `docs/engineering/23-music-setup.md`.

## Context

Users want to ask ELISE for music the way they ask a person ("poneme algo tranquilo para
estudiar", "pasá esta", "bajalo un poco", "mandalo al parlante") and see what is playing.
Opening a music website is not that.

The provider landscape was verified against official documentation in October 2026:

- **Spotify.** Web API player endpoints (`/me/player`: state, devices, transfer, play, pause,
  next, previous, seek, volume) are unaffected by the February 2026 changes. Other parts changed:
  - Development mode allows 5 users per app, and the owner needs Premium.
  - Search returns at most 10 results per type.
  - Artist top tracks and browse are removed; recommendations and related artists were already
    gone for new apps.
  - `user.product` and `email` were removed from the user object.
  - Refresh tokens expire 6 months after consent (`invalid_grant`).
  - Redirect URIs must be HTTPS or `http://127.0.0.1:PORT` ("localhost" is rejected).
  - Playback control and the Web Playback SDK require Premium, and the SDK "must not be used in
    commercial projects without Spotify's prior written approval".
  - Extended quota (production) requires a registered business with 250k MAU.
- **YouTube.**
  - The Data API v3 (search) and the IFrame Player API (playback) are official.
  - Developer policies forbid background players (not displayed in the page the user is
    viewing) and separating audio from video.
  - The player needs at least a 200×200 viewport, and cached API data lasts at most 30 days.
- **Deezer.** The developer portal is not accepting new applications (since 2025), so no
  adapter can be built or tested now.

## Decision

1. **One canonical capability**, `music` (`core/capabilities/music.ts`).
   - `MusicProvider` declares its features: search, playlists, remote_playback, browser_player,
     embedded_playback, devices, transfer, volume, seek, queue.
   - Operations a provider doesn't declare fail as `CAPABILITY_UNAVAILABLE`. Nothing is faked.
   - Pure decisions live in core and are tested:
     - `pickToPlay`: an exact request plays an artist as an artist and never asks "which song";
       a name with no confident match becomes a question; a discovery request picks a
       playlist first.
     - `nextVolume`, `pickDevice` ("el parlante del living", "otro dispositivo") and
       `duckedVolume`.
2. **Canonical tools**: `music.search`, `getPlayback`, `listDevices`, `play`, `pause`,
   `resume`, `next`, `previous`, `seek`, `setVolume`, `transfer`.
   - The model never sees provider names as tools.
   - Reads are reads. Controls are low-risk writes that never ask for approval: they only change
     the user's own player.
   - Pause, resume, skip and volume confirm without a second model call.
3. **Two kinds of provider.**
   - **Remote** (Spotify): commands go to the provider. The tool reads the state again after a
     short settle, and the page polls `/api/music/playback` (4 s while playing, 12 s paused,
     30 s hidden). Changes made in the Spotify app therefore reach ELISE. Polling is a direct
     read and never writes action traces.
   - **Embedded** (YouTube): the player lives in the page. Tools return a `MusicCommand` that
     the page executes, and the page sends the player's state with each turn
     (`ToolContext.music`), never stored.
4. **Spotify adapter.**
   - OAuth authorization code with PKCE; the client secret stays on the server.
   - Encrypted credentials go through the existing vault.
   - Refreshes rotate the refresh token when Spotify sends a new one.
   - `invalid_grant` or a revoked token marks the connection for reconnection.
   - Disconnect deletes the credential (Spotify has no revocation endpoint).
   - Scopes: playback read and modify, currently-playing, own and collaborative playlists, and
     `streaming` with the two profile scopes the SDK requires.
   - Errors keep their meaning: `PREMIUM_REQUIRED` says Premium is required; `NO_ACTIVE_DEVICE`
     falls back to ELISE's own player or the only device available, and otherwise says so;
     429 is a rate limit.
   - **Browser playback.** The Web Playback SDK registers "ELISE" as a Spotify Connect device in
     the page. It gets a short-lived access token from `/api/music/token` (never the refresh
     token). The first tap unlocks audio (`activateElement`). Non-Premium accounts keep
     controlling their other devices.
5. **YouTube adapter.**
   - Data API search (music category, embeddable), using ELISE's server key; no user account.
   - Turning it on records a connection so Music resolves to it.
   - Playback uses the IFrame player in a small floating frame that is always visible while it
     plays: 356×200, or 480×270 when video was asked for. It persists across pages, and
     closing it stops playback.
   - ELISE plays a controlled queue (the matching videos), so next and previous work.
6. **One Music Surface**, `current_music_playback`.
   - Track changes, pauses, searches and device lists update the same Surface. It is sticky
     while playing (it survives turn decay), ambient priority, and compact by default.
   - Compact view: artwork, song, artist, play/pause, next, and a decorative equalizer.
   - Larger views add progress, previous, volume, devices, results, queue and an "open in"
     link.
   - The equalizer breathes while playing and rests when paused. It is never derived from the
     audio, and reduced motion keeps it still.
   - The Surface renders the page's live state (`musicStore`) when it is for the same provider.
7. **One state in the page** (`features/music/store.ts`).
   - Fed by tool results, polling, and the SDK and IFrame events.
   - The Surface, a quiet **mini-player** (shown off the Canvas, for remote playback) and
     ducking all read it. There is no second player state.
8. **Voice.**
   - **Ducking** while ELISE speaks lowers the music to 35 % of its volume and restores
     exactly what it was. It runs only where the volume can be set precisely: the YouTube
     player, ELISE's Spotify device, or a remote device that supports volume. On by default;
     per-browser toggle `elise.music.duck`.
   - **Turn detection.** Music starting or stopping while listening makes the legacy controller
     re-measure the room's floor, so steady music isn't heard as speech. Barge-in is unchanged:
     it compares the mic against ELISE's own voice. GPT-Live relies on its echo cancellation and
     server VAD.
9. **Methods, Shortcuts and schedules.**
   - A Method's text adds the music tool group when it mentions music.
   - Music runs through the canonical tools only; no credentials or APIs in Methods.
   - The guidance forbids starting music unasked, including in briefs and schedules.
10. **Desktop Companion readiness.** `MusicProviderKey` includes `device` for a future media
    session and system now-playing adapter behind the same contract and tools. Not implemented.

## Consequences

- New providers (Deezer when its API reopens, Apple Music, a local or desktop player) only need
  an adapter and a connection flow; tools, Surface and voice behave the same.
- **Policy limits.** Spotify playback in ELISE is a development and personal integration (up to
  5 allow-listed Premium users). Commercial availability needs Spotify's extended quota and
  written approval for the SDK. ELISE's commercial plans must not assume embedded Spotify
  streaming. YouTube playback is always visible, and it stops when the page closes.
- "Algo parecido a X" can't use similarity recommendations (removed from the Web API): the model
  describes the style and searches for it.
- Remote state is eventually consistent (polling every few seconds), and a remote volume duck
  arrives with network latency.

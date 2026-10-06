# Music setup (ADR-042)

## Spotify

1. Open <https://developer.spotify.com/dashboard> with the account that will own the app. Since
   February 2026 that account needs **Spotify Premium**, or the app stops working.
2. **Create app**:
   - APIs: **Web API** and **Web Playback SDK**.
   - Redirect URI: `{NEXT_PUBLIC_APP_URL}/api/connections/spotify/callback`.
     - Production: `https://your-domain/api/connections/spotify/callback`.
     - Local: `http://127.0.0.1:3000/api/connections/spotify/callback`. Spotify rejects
       `localhost`, so open ELISE at `http://127.0.0.1:3000` while connecting, and set
       `NEXT_PUBLIC_APP_URL` to match (or set `SPOTIFY_REDIRECT_URI`).
3. In **User Management**, add every Spotify account that will connect (up to 5 in development
   mode).
4. Environment (server only, never `NEXT_PUBLIC_*`):

   ```env
   SPOTIFY_CLIENT_ID=...
   SPOTIFY_CLIENT_SECRET=...
   # Optional, when the redirect isn't {NEXT_PUBLIC_APP_URL}/api/connections/spotify/callback
   SPOTIFY_REDIRECT_URI=...
   ```

   `ELISE_ENCRYPTION_KEY` and `SUPABASE_SECRET_KEY` must already be set (credentials are stored
   encrypted).
5. Apply migration `20261014000033_music.sql`.
6. Go to **Connections › Music › Connect Spotify**.

What to expect:

- Control and "ELISE" as a playback device require Premium. A non-Premium account can search,
  and ELISE says exactly why it can't play.
- Spotify asks you to reconnect 6 months after consent; ELISE marks the connection when that
  happens.

## YouTube

1. In Google Cloud Console, enable **YouTube Data API v3** and create an API key. Restrict it to
   that API (and to your server's IPs if possible).
2. Set `YOUTUBE_API_KEY=...` (server only).
3. Go to **Connections › Music › Turn on YouTube**.

What to expect:

- The default quota is 10,000 units a day; a search costs 100.
- Playback is the official embedded player, always visible while it plays (YouTube policy).

## Deezer

Not available: Deezer's developer portal isn't accepting new applications. The provider
interface is ready for an adapter when it reopens.

## Choosing the default

When both Spotify and YouTube are connected, the first one connected is the default for Music.
Change it in **Connections** (default per capability), or say it: "poné X en YouTube".

import type {
  MusicCommand,
  MusicDevice,
  MusicFeature,
  MusicItem,
  MusicKind,
  MusicProvider,
  Playback,
  PlayTarget,
} from "@/core/capabilities/music";
import { AppError } from "@/core/errors";
import type {
  ConnectionRef,
  CredentialVault,
  StoredCredential,
} from "@/infrastructure/providers/google/credentials";

import { refreshSpotifyToken, type FetchLike, type SpotifyOAuthConfig } from "./oauth";

/**
 * Spotify as a MusicProvider (ADR-042), on the Web API endpoints that remain available to
 * development-mode apps after the February 2026 changes: search (max 10 per type), the
 * current user's playlists, and every /me/player endpoint (state, devices, transfer, play,
 * pause, next, previous, seek, volume). Playback control requires Spotify Premium; Spotify
 * answers 403 PREMIUM_REQUIRED otherwise, and ELISE says exactly that.
 */

export const SPOTIFY_API = "https://api.spotify.com/v1";
/** The name of ELISE's own player in this browser (Web Playback SDK). */
export const SPOTIFY_BROWSER_DEVICE = "ELISE";

const REFRESH_MARGIN_MS = 60_000;

/** A valid access token for one connection; refreshes and rotates; fails closed when revoked. */
export class SpotifyTokenProvider {
  private cached: StoredCredential | null = null;
  constructor(
    private readonly ref: ConnectionRef,
    private readonly deps: {
      vault: CredentialVault;
      config: () => SpotifyOAuthConfig;
      onReauthorizationRequired: (ref: ConnectionRef, code: string) => Promise<void>;
      fetchImpl?: FetchLike;
      now?: () => number;
    },
  ) {}

  async accessToken(forceRefresh = false): Promise<string> {
    const now = this.deps.now?.() ?? Date.now();
    const current = this.cached ?? (await this.deps.vault.read(this.ref));
    if (!current?.refreshToken) {
      await this.deps.onReauthorizationRequired(this.ref, "missing_credentials");
      throw reconnect();
    }
    this.cached = current;
    if (!forceRefresh && Date.parse(current.accessTokenExpiresAt) - REFRESH_MARGIN_MS > now)
      return current.accessToken;
    try {
      const t = await refreshSpotifyToken(
        this.deps.config(),
        current.refreshToken,
        this.deps.fetchImpl,
        now,
      );
      const next: StoredCredential = {
        accessToken: t.accessToken,
        accessTokenExpiresAt: t.expiresAt.toISOString(),
        // Spotify may rotate the refresh token; keep the old one when it doesn't.
        refreshToken: t.refreshToken ?? current.refreshToken,
        scopes: t.scopes.length ? t.scopes : current.scopes,
      };
      await this.deps.vault.write(this.ref, next);
      this.cached = next;
      return next.accessToken;
    } catch (error) {
      if (error instanceof AppError && error.code === "AUTH_EXPIRED")
        await this.deps.onReauthorizationRequired(this.ref, "invalid_grant");
      throw error;
    }
  }
}

const reconnect = () =>
  new AppError("AUTH_EXPIRED", "This Spotify account needs to be reconnected", {
    recovery: "reconnect",
  });

interface SpotifyImage {
  url: string;
}
interface SpotifyArtist {
  name: string;
  uri: string;
  images?: SpotifyImage[];
  external_urls?: { spotify?: string };
}
interface SpotifyTrack {
  uri: string;
  name: string;
  duration_ms?: number;
  artists?: { name: string }[];
  album?: { name: string; uri: string; images?: SpotifyImage[] };
  external_urls?: { spotify?: string };
  type?: string;
}
interface SpotifyAlbum {
  uri: string;
  name: string;
  artists?: { name: string }[];
  images?: SpotifyImage[];
  external_urls?: { spotify?: string };
}
interface SpotifyPlaylist {
  uri: string;
  name: string;
  owner?: { display_name?: string };
  images?: SpotifyImage[] | null;
  external_urls?: { spotify?: string };
}
interface SpotifyDevice {
  id: string | null;
  name: string;
  type: string;
  is_active: boolean;
  is_restricted: boolean;
  volume_percent: number | null;
  supports_volume?: boolean;
}

const art = (images: SpotifyImage[] | null | undefined) =>
  images?.find((i) => i?.url?.startsWith("https://"))?.url ?? null;
const names = (xs: { name: string }[] | undefined) => xs?.map((a) => a.name).join(", ") || null;

export const trackItem = (t: SpotifyTrack): MusicItem => ({
  ref: t.uri,
  kind: "track",
  title: t.name,
  subtitle: names(t.artists),
  artwork: art(t.album?.images),
  durationMs: t.duration_ms ?? null,
  url: t.external_urls?.spotify ?? null,
  provider: "spotify",
});

function deviceOf(d: SpotifyDevice): MusicDevice {
  const t = d.type.toLowerCase();
  return {
    id: d.id ?? "",
    name: d.name,
    type:
      d.name === SPOTIFY_BROWSER_DEVICE
        ? "browser"
        : t === "computer"
          ? "computer"
          : t === "smartphone" || t === "tablet"
            ? "smartphone"
            : t === "speaker" || t === "castaudio" || t === "avr" || t === "stb"
              ? "speaker"
              : t === "tv" || t === "castvideo"
                ? "tv"
                : "other",
    active: d.is_active,
    volume: d.volume_percent,
    supportsVolume: d.supports_volume ?? d.volume_percent !== null,
    restricted: d.is_restricted,
  };
}

/** Spotify's error, as the user should hear it (never a provider payload). */
export function spotifyError(status: number, reason: string | undefined, message: string) {
  if (status === 401) return reconnect();
  if (status === 403 && reason === "PREMIUM_REQUIRED")
    return new AppError(
      "CAPABILITY_UNAVAILABLE",
      "Spotify only lets apps control playback for Premium accounts. This account isn't Premium, so ELISE can search but not play.",
      { recovery: "none", details: { reason } },
    );
  if (status === 403)
    return new AppError(
      "PERMISSION_DENIED",
      `Spotify refused: ${message || reason || "forbidden"}`,
      {
        recovery: "none",
        details: { reason },
      },
    );
  if (status === 404 && reason === "NO_ACTIVE_DEVICE")
    return new AppError(
      "CAPABILITY_UNAVAILABLE",
      "No Spotify device is active. Open Spotify on a device (or let ELISE play here) and try again.",
      { recovery: "retry", details: { reason } },
    );
  if (status === 429)
    return new AppError(
      "RATE_LIMITED",
      "Spotify is limiting requests right now. Try again in a moment.",
    );
  return new AppError("PROVIDER_UNAVAILABLE", `Spotify error ${status}`, { details: { reason } });
}

const FEATURES: ReadonlySet<MusicFeature> = new Set([
  "search",
  "playlists",
  "remote_playback",
  "browser_player",
  "devices",
  "transfer",
  "volume",
  "seek",
  "queue",
]);

export class SpotifyMusicProvider implements MusicProvider {
  readonly key = "spotify" as const;
  readonly features = FEATURES;

  constructor(
    private readonly tokens: { accessToken(force?: boolean): Promise<string> },
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  private async call<T>(
    method: string,
    path: string,
    body?: unknown,
    retried = false,
  ): Promise<T | null> {
    const token = await this.tokens.accessToken(retried);
    let res: Response;
    try {
      res = await this.fetchImpl(`${SPOTIFY_API}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(12_000),
      });
    } catch (cause) {
      throw new AppError("PROVIDER_UNAVAILABLE", "Spotify did not respond", { cause });
    }
    if (res.status === 401 && !retried) return this.call<T>(method, path, body, true);
    if (res.status === 204 || res.status === 202) return null;
    const text = await res.text();
    const json = text ? (JSON.parse(text) as unknown) : null;
    if (!res.ok) {
      const err = (json as { error?: { reason?: string; message?: string } } | null)?.error;
      throw spotifyError(res.status, err?.reason, err?.message ?? "");
    }
    return json as T;
  }

  async search(q: { query: string; kinds: MusicKind[]; limit: number }): Promise<MusicItem[]> {
    const types = q.kinds.filter((k) => k !== "video");
    if (!types.length) return [];
    // Development mode: at most 10 per type (since February 2026).
    const limit = Math.min(10, Math.max(1, Math.ceil(q.limit / types.length) + 1));
    const r = await this.call<{
      artists?: { items: (SpotifyArtist | null)[] };
      albums?: { items: (SpotifyAlbum | null)[] };
      tracks?: { items: (SpotifyTrack | null)[] };
      playlists?: { items: (SpotifyPlaylist | null)[] };
    }>(
      "GET",
      `/search?${new URLSearchParams({ q: q.query, type: types.join(","), limit: String(limit) })}`,
    );
    const out: MusicItem[] = [];
    // Interleave by kind so the best of each is near the top.
    for (let i = 0; i < limit; i++) {
      const a = r?.artists?.items[i];
      if (a)
        out.push({
          ref: a.uri,
          kind: "artist",
          title: a.name,
          subtitle: null,
          artwork: art(a.images),
          durationMs: null,
          url: a.external_urls?.spotify ?? null,
          provider: "spotify",
        });
      const al = r?.albums?.items[i];
      if (al)
        out.push({
          ref: al.uri,
          kind: "album",
          title: al.name,
          subtitle: names(al.artists),
          artwork: art(al.images),
          durationMs: null,
          url: al.external_urls?.spotify ?? null,
          provider: "spotify",
        });
      const t = r?.tracks?.items[i];
      if (t) out.push(trackItem(t));
      const p = r?.playlists?.items[i];
      if (p) out.push(playlistItem(p));
    }
    return out;
  }

  async myPlaylists(): Promise<MusicItem[]> {
    const r = await this.call<{ items: (SpotifyPlaylist | null)[] }>(
      "GET",
      "/me/playlists?limit=50",
    );
    return (r?.items ?? []).filter((p): p is SpotifyPlaylist => Boolean(p)).map(playlistItem);
  }

  async playback(): Promise<Playback | null> {
    const r = await this.call<{
      is_playing: boolean;
      progress_ms: number | null;
      item: SpotifyTrack | null;
      context: { type: string; uri: string } | null;
      device: SpotifyDevice | null;
    }>("GET", "/me/player");
    if (!r) return null;
    const item = r.item ? trackItem(r.item) : null;
    const kind = (r.context?.type ?? "") as MusicKind;
    return {
      provider: "spotify",
      playing: r.is_playing,
      item,
      context: r.context
        ? {
            kind: ["album", "artist", "playlist"].includes(kind) ? kind : "playlist",
            title: kind === "album" ? (r.item?.album?.name ?? null) : null,
            ref: r.context.uri,
          }
        : null,
      progressMs: r.progress_ms ?? 0,
      durationMs: item?.durationMs ?? 0,
      device: r.device ? deviceOf(r.device) : null,
      volume: r.device?.volume_percent ?? null,
      at: new Date().toISOString(),
    };
  }

  async devices(): Promise<MusicDevice[]> {
    const r = await this.call<{ devices: SpotifyDevice[] }>("GET", "/me/player/devices");
    return (r?.devices ?? []).filter((d) => d.id).map(deviceOf);
  }

  async play(t: PlayTarget): Promise<MusicCommand | void> {
    const body = t.tracks?.length
      ? { uris: t.tracks.map((x) => x.ref).slice(0, 50) }
      : t.item && t.item.kind !== "track"
        ? { context_uri: t.item.ref }
        : t.item
          ? { uris: [t.item.ref] }
          : undefined;
    const go = (deviceId: string | null) =>
      this.call(
        "PUT",
        `/me/player/play${deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : ""}`,
        body,
      );
    try {
      await go(t.deviceId ?? null);
    } catch (error) {
      if (
        !(error instanceof AppError && error.details?.reason === "NO_ACTIVE_DEVICE") ||
        t.deviceId
      )
        throw error;
      // No device is active: ELISE's own player here, else the only device there is.
      const devices = (await this.devices()).filter((d) => !d.restricted);
      const target =
        devices.find((d) => d.type === "browser") ?? (devices.length === 1 ? devices[0] : null);
      if (!target) throw error;
      await go(target.id);
    }
  }

  async pause() {
    await this.call("PUT", "/me/player/pause");
  }
  async resume() {
    await this.call("PUT", "/me/player/play");
  }
  async next() {
    await this.call("POST", "/me/player/next");
  }
  async previous() {
    await this.call("POST", "/me/player/previous");
  }
  async seek(ms: number) {
    await this.call("PUT", `/me/player/seek?position_ms=${Math.round(ms)}`);
  }
  async setVolume(percent: number) {
    await this.call("PUT", `/me/player/volume?volume_percent=${Math.round(percent)}`);
  }
  async transfer(deviceId: string, play: boolean) {
    await this.call("PUT", "/me/player", { device_ids: [deviceId], play });
  }
}

function playlistItem(p: SpotifyPlaylist): MusicItem {
  return {
    ref: p.uri,
    kind: "playlist",
    title: p.name,
    subtitle: p.owner?.display_name ?? null,
    artwork: art(p.images),
    durationMs: null,
    url: p.external_urls?.spotify ?? null,
    provider: "spotify",
  };
}

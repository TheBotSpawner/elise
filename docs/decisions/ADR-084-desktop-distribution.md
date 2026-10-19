# ADR-084: ELISE Desktop distribution — beta installer, stable channel manifests, one publication path

**Status:** Accepted (2026-10-19). Builds on ADR-081/082.

## Context

ELISE Web said "ELISE Desktop todavía no está disponible para Windows", and a Desktop build
opened `http://localhost:3999/desktop/connect`. The causes:

- **Wrong Cloud URL in the build.** The Cloud URL is baked in at build time
  (`process.env` > `.env.local`), and that build was made with a local URL for a smoke test.
  Editing `.env` afterwards changes nothing in an existing `.exe`.
- **Nothing published.** No release or manifest existed, so the web correctly had nothing to
  offer.
- **No stable manifest URL.** The previous design placed the manifest in a draft-then-publish
  flow, and Vercel would have needed a new URL per release.

## Decision

**Artifacts.** These are different things, and only the installer is offered to people:

| Path | What | Who uses it |
|---|---|---|
| `desktop/out/ELISE-win32-x64/` | the unpacked app | development, `smoke:desktop`. Never a download |
| `desktop/out/make/squirrel.windows/x64/ELISE-Setup-<version>.exe` | the Windows installer | people |
| `…/RELEASES`, `…/elise_desktop-<nuget version>-full.nupkg` | the Squirrel update feed | ELISE Desktop's updater |

**Build guard.** A packaged (production) build fails unless `ELISE_CLOUD_URL` is a non-local
https origin (`desktop/cloud-url.ts`). Every build writes `.vite/build/build-info.json`
(version, Cloud, channel, feed). The publisher refuses a build whose version, channel or Cloud
doesn't match. The installed app reports its Cloud (`getDesktopInfo().cloudOrigin`), and the
installer smoke test checks it.

**Hosting: GitHub Releases of this public repository.** No other infrastructure is needed.

- **Versioned release** `desktop-v<semver>` (immutable): the installer, the `.nupkg`, and
  `RELEASES`.
- **Fixed channel releases** `desktop-beta` / `desktop-stable`, holding:
  - the channel's Squirrel feed (`RELEASES` and the `.nupkg` files);
  - `desktop-releases.json`, the manifest ELISE Web reads. Same schema as before, with that
    channel's history; withdrawn versions stay listed but are never offered.

**Stable URLs.** Configured once and never edited per release:

```text
ELISE_DESKTOP_MANIFEST_URL = https://github.com/TheBotSpawner/elise/releases/download/desktop-{channel}/desktop-releases.json   (Vercel)
ELISE_UPDATE_FEED          = https://github.com/TheBotSpawner/elise/releases/download                                       (Desktop build)
```

The web substitutes `{channel}`. The updater reads `<feed>/desktop-<channel>/RELEASES`.

**One publication path:** `desktop/scripts/publish-release.mjs`, run by the `desktop-v*` tag
workflow. The order is fixed:

1. Check the policy.
2. Check `build-info.json`.
3. Publish the versioned release and its assets.
4. Re-download the installer and verify its SHA-256.
5. Update the channel's feed (`.nupkg`, then `RELEASES`).
6. Update the channel manifest, **last**.

A failure at any step leaves the active manifest unchanged.

**Withdrawing a version** is "Run workflow" with that version. It marks the version withdrawn,
and both the manifest and the updater feed point back at the previous good version.

**Policy:**
- Versions are SemVer, with one source: `desktop/package.json`. The bridge, local-runtime and
  Home runtime versions stay separate.
- A pre-release goes to **beta**, which may be unsigned and says so. A plain version goes to
  **stable**, which requires signing.
- Stable never contains pre-releases. Promoting to stable means a signed build of the same
  commit.

**Who sees beta.** In production, people in `ELISE_ADMIN_EMAILS` (testers) see beta and stable.
Everyone else sees stable only (unsigned builds are never a public stable download). Outside
production, everyone sees beta. `ELISE_DESKTOP_DOWNLOAD_CHANNEL` can force either.

**Caching.** The web caches each manifest for 5 minutes per server instance, with `no-store`
on the fetch. GitHub serves release assets through its CDN, and a re-uploaded asset gets a new
object, so a new release shows up within minutes with no redeploy. Installers are immutable per
version.

## Consequences

- A release needs the code committed and a `desktop-v<version>` tag pushed. The workflow does
  the rest.
- The repository must stay public for anonymous downloads. If it ever goes private, the same
  script would publish to another public host (a storage bucket) without changing the web
  contract: one manifest URL per channel.
- macOS isn't built or offered until signing and notarization exist (the workflow publishes
  Windows only).

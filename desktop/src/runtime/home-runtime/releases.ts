/**
 * The managed Home runtime releases this Desktop build may install (ADR-082) — an allowlist
 * shipped inside the signed app, never fetched: a new runtime arrives with a Desktop update.
 * Every artifact is pinned: the base system by SHA-256, the engine by its OCI digest (the
 * registry and podman verify it on pull). Nothing user-provided is ever downloaded or run.
 */
export interface HomeRuntimeRelease {
  /** ELISE's own runtime version (base + engine + provisioning script). */
  version: string;
  base: { url: string; sha256: string; sizeBytes: number };
  /** Home Assistant Container, by digest. */
  engineImage: string;
  engineVersion: string;
}

export const HOME_RUNTIME_RELEASES: readonly HomeRuntimeRelease[] = [
  {
    version: "2026.10.2-elise.1",
    // Alpine Linux minirootfs 3.24.2 (published 2026-09-17), sha256 from Alpine's release index.
    base: {
      url: "https://dl-cdn.alpinelinux.org/alpine/v3.24/releases/x86_64/alpine-minirootfs-3.24.2-x86_64.tar.gz",
      sha256: "c5ca053cfe1d85c5b96dff8b9bc57045f7f184a30ffb6b65776409ca90388677",
      sizeBytes: 3_701_382,
    },
    // Home Assistant 2026.10.2 (the "stable" tag on 2026-10-18), multi-arch index digest.
    engineImage:
      "ghcr.io/home-assistant/home-assistant@sha256:33afb0659d786213264c2211f8d91c5fe87461c56eba6a3a546eb05fc71e89f4",
    engineVersion: "2026.10.2",
  },
];

/** The newest allowlisted release: what setup installs and what updates move to. */
export const CURRENT_HOME_RUNTIME = HOME_RUNTIME_RELEASES[HOME_RUNTIME_RELEASES.length - 1]!;

export const isAllowedRelease = (version: string | null) =>
  HOME_RUNTIME_RELEASES.some((r) => r.version === version);

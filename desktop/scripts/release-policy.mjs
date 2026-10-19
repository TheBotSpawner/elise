// ELISE Desktop release policy (ADR-084), pure so it's tested: what may be published where, and
// how a channel's manifest changes. Same schema the web reads (src/core/platform/releases.ts).

const LOCAL = /^https?:\/\/(localhost|127(?:\.\d+){3}|0\.0\.0\.0|\[::1\])(?::\d+)?/i;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;

/** Throws when this build must not be published on this channel. */
export function assertPublishable({ version, channel, signed, cloudUrl, installerName }) {
  if (!SEMVER.test(version)) throw new Error(`Version ${version} isn't SemVer`);
  if (!installerName || !installerName.includes(version))
    throw new Error(`Installer ${installerName} doesn't match version ${version}`);
  if (!cloudUrl || LOCAL.test(cloudUrl) || !cloudUrl.startsWith("https://"))
    throw new Error(
      `This build talks to ${cloudUrl || "nothing"}: rebuild with a production ELISE_CLOUD_URL`,
    );
  if (channel === "stable") {
    if (!signed)
      throw new Error("A stable release must be signed (publish unsigned builds on beta)");
    if (version.includes("-")) throw new Error(`Pre-release ${version} can't go to stable`);
  }
}

/** Adds (or replaces) one release; never drops history. */
export function manifestWith(manifest, entry) {
  const same = (r) =>
    r.version === entry.version && r.platform === entry.platform && r.arch === entry.arch;
  return {
    schemaVersion: 1,
    releases: [...(manifest?.releases ?? []).filter((r) => !same(r)), entry],
  };
}

/** Marks a version withdrawn: never offered again; the previous good one takes over. */
export function withdrawn(manifest, version) {
  if (!(manifest?.releases ?? []).some((r) => r.version === version))
    throw new Error(`No release ${version} in this channel`);
  return {
    schemaVersion: 1,
    releases: manifest.releases.map((r) =>
      r.version === version ? { ...r, state: "withdrawn" } : r,
    ),
  };
}

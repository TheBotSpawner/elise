// ELISE Desktop release publication (ADR-084). One command for beta and stable, used by CI:
//
//   node desktop/scripts/publish-release.mjs --channel beta  [--signed] [--repo owner/name] [--dry-run]
//   node desktop/scripts/publish-release.mjs --channel beta --withdraw 0.1.0-beta.2
//
// Hosting: GitHub Releases of this (public) repository — no other infrastructure.
//   desktop-v<version>  (immutable)  ELISE-Setup-<version>.exe, the .nupkg and its RELEASES
//   desktop-<channel>   (fixed)      the channel's Squirrel feed (RELEASES + .nupkg files) and
//                                    desktop-releases.json — the manifest ELISE Web reads.
// Stable URLs (configure once, never per release):
//   https://github.com/<repo>/releases/download/desktop-{channel}/desktop-releases.json
//
// Order (nothing points at a release that isn't downloadable and verified):
//   policy → build checks → versioned release + assets → re-download and verify SHA-256 →
//   channel feed (.nupkg, then RELEASES) → channel manifest LAST. Any failure leaves the active
//   manifest as it was.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

import { assertPublishable, manifestWith, withdrawn } from "./release-policy.mjs";

const args = process.argv.slice(2);
const opt = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const flag = (name) => args.includes(`--${name}`);

const DESKTOP = fileURLToPath(new URL("..", import.meta.url));
const channel = opt("channel");
const repo = opt("repo", process.env.GITHUB_REPOSITORY ?? "TheBotSpawner/elise");
const dry = flag("dry-run");
const signed = flag("signed");
const channelTag = `desktop-${channel}`;
const MANIFEST = "desktop-releases.json";
const work = mkdtempSync(join(tmpdir(), "elise-release-"));

const gh = (...a) => execFileSync("gh", [...a, "--repo", repo], { encoding: "utf8" });
/**
 * One file to a release: skipped when the same name and size is already there (a re-run never
 * re-sends ~200 MB), otherwise uploaded with a few retries — GitHub cuts long uploads now and
 * then (HTTP 408). Files go one by one: "--clobber" on several at once deletes the old copies
 * first and leaves the release without them if the upload then fails.
 */
async function upload(releaseTag, file) {
  const name = basename(file);
  const size = statSync(file).size;
  const assets = tryGh("release", "view", releaseTag, "--json", "assets");
  const have = assets
    ? JSON.parse(assets).assets.find((a) => a.name === name && a.state === "uploaded")
    : null;
  // Only the big, versioned binaries are skipped: RELEASES and the manifest change content
  // without necessarily changing size, so they're always sent.
  if (have?.size === size && size > 1_000_000) return step(`already up: ${name}`);
  for (let i = 1; ; i++) {
    try {
      gh("release", "upload", releaseTag, file, "--clobber");
      return step(`uploaded ${name}`);
    } catch (err) {
      if (i >= 4) throw err;
      step(
        `upload of ${name} failed (${String(err.stderr ?? err.message)
          .trim()
          .slice(0, 120)}); retrying`,
      );
      await new Promise((r) => setTimeout(r, 5000 * i));
    }
  }
}

const tryGh = (...a) => {
  try {
    return gh(...a);
  } catch {
    return null;
  }
};
const step = (s) => console.log(`• ${s}`);
const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const downloadUrl = (tag, name) =>
  `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(name)}`;

// GitHub's CDN sometimes resets a large download midway, and a ~200 MB asset just uploaded can
// answer 404 for a minute or more: retry (about 2 minutes in all) before failing the release.
async function fetchBytes(url, attempts = 8) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url, { redirect: "follow", cache: "no-store" });
      if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      if (i >= attempts) throw err;
      await new Promise((r) => setTimeout(r, 3000 * i));
    }
  }
}

async function currentManifest() {
  try {
    return JSON.parse((await fetchBytes(downloadUrl(channelTag, MANIFEST))).toString("utf8"));
  } catch {
    return { schemaVersion: 1, releases: [] };
  }
}

function ensureChannelRelease() {
  if (tryGh("release", "view", channelTag)) return;
  step(`create the fixed ${channelTag} release`);
  if (!dry)
    gh(
      "release",
      "create",
      channelTag,
      "--title",
      `ELISE Desktop · ${channel} channel`,
      "--notes",
      `Fixed release holding the ${channel} channel's update feed and ${MANIFEST} (ADR-084). Its content changes with every ${channel} release; its URL never does.`,
      "--latest=false",
      ...(channel === "stable" ? [] : ["--prerelease"]),
    );
}

async function uploadManifest(manifest) {
  const file = join(work, MANIFEST);
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  step(`publish ${MANIFEST} → ${downloadUrl(channelTag, MANIFEST)}`);
  if (!dry) await upload(channelTag, file);
}

if (!["beta", "stable"].includes(channel)) throw new Error("--channel beta|stable");

// ── Withdraw: the channel goes back to its previous good release ─────────────
const withdrawVersion = opt("withdraw");
if (withdrawVersion) {
  const manifest = withdrawn(await currentManifest(), withdrawVersion);
  const back = manifest.releases
    .filter((r) => r.state === "published" && r.platform === "windows")
    .sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : -1))[0];
  if (back) {
    // The updater follows the same move: RELEASES from the previous good version.
    const rel = join(work, "RELEASES");
    writeFileSync(rel, await fetchBytes(downloadUrl(`desktop-v${back.version}`, "RELEASES")));
    step(`updater feed → ${back.version}`);
    if (!dry) await upload(channelTag, rel);
  }
  await uploadManifest(manifest);
  console.log(`Withdrew ${withdrawVersion}; ${channel} now offers ${back?.version ?? "nothing"}.`);
  process.exit(0);
}

// ── Publish ──────────────────────────────────────────────────────────────────
const version = JSON.parse(readFileSync(join(DESKTOP, "package.json"), "utf8")).version;
const tag = `desktop-v${version}`;
const make = join(DESKTOP, "out", "make", "squirrel.windows", "x64");
const files = existsSync(make) ? readdirSync(make) : [];
const setup = files.find((f) => f.endsWith(".exe") && f.includes(version));
// The package Squirrel built for this version is the one its RELEASES index names.
const nupkg = files.includes("RELEASES")
  ? readFileSync(join(make, "RELEASES"), "utf8").trim().split(/\s+/)[1]
  : null;
if (!setup || !nupkg || !files.includes(nupkg))
  throw new Error(`No Windows installer for ${version} in ${make}. Run: npm run make:desktop`);

// What the build was configured with (written by vite.main.config.ts).
const info = JSON.parse(readFileSync(join(DESKTOP, ".vite", "build", "build-info.json"), "utf8"));
if (info.version !== version)
  throw new Error(`Build is ${info.version}, package.json says ${version}: rebuild`);
if (info.channel !== channel)
  throw new Error(`Build is for ${info.channel}, publishing to ${channel}: rebuild`);
const cloud = info.cloudUrl;
assertPublishable({
  version,
  channel,
  signed,
  cloudUrl: cloud,
  updateFeed: info.updateFeed,
  installerName: setup,
});
step(`ELISE Desktop ${version} · ${channel} · ${signed ? "signed" : "unsigned"} · cloud ${cloud}`);

// A stable, space-free asset name (GitHub would rewrite spaces).
const installerName = `ELISE-Setup-${version}.exe`;
const installer = join(work, installerName);
copyFileSync(join(make, setup), installer);
const sum = sha256(installer);
const size = statSync(installer).size;

// 1. The versioned, immutable release — created as a draft: a draft has no tag yet, so the
// tag-triggered workflow can't start before the installer is up (it then sees it and skips).
let draft = false;
if (!tryGh("release", "view", tag)) {
  step(`create release ${tag} (draft until its files are up)`);
  draft = true;
  if (!dry)
    gh(
      "release",
      "create",
      tag,
      "--draft",
      "--title",
      `ELISE Desktop ${version}`,
      "--notes",
      `ELISE Desktop ${version} (${channel}${signed ? "" : ", unsigned: Windows SmartScreen will warn"}).\nSHA-256 ${sum}`,
      "--latest=false",
      ...(channel === "stable" ? [] : ["--prerelease"]),
    );
}
step(`upload ${installerName}, ${nupkg}, RELEASES to ${tag}`);
if (!dry)
  for (const file of [installer, join(make, nupkg), join(make, "RELEASES")])
    await upload(tag, file);
if (draft) {
  step(`publish ${tag}`);
  if (!dry) gh("release", "edit", tag, "--draft=false");
}

// 2. Downloadable, and the same bytes.
const installerUrl = downloadUrl(tag, installerName);
if (!dry) {
  const got = createHash("sha256")
    .update(await fetchBytes(installerUrl))
    .digest("hex");
  if (got !== sum)
    throw new Error(`Downloaded installer checksum ${got} ≠ ${sum}: manifest NOT updated`);
  step("verified: downloaded installer matches the build");
}

// 3. The channel's update feed (packages first, then the index that points at them).
ensureChannelRelease();
step(`update feed ${channelTag}: ${nupkg}, then RELEASES`);
if (!dry) {
  await upload(channelTag, join(make, nupkg));
  await upload(channelTag, join(make, "RELEASES"));
}

// 4. LAST: the manifest ELISE Web reads.
const manifest = manifestWith(await currentManifest(), {
  version,
  channel,
  state: "published",
  platform: "windows",
  arch: "x64",
  installerUrl,
  sha256: sum,
  sizeBytes: size,
  publishedAt: new Date().toISOString(),
  signed,
  minimumSupportedBridgeProtocol: 1,
  releaseNotesUrl: `https://github.com/${repo}/releases/tag/${tag}`,
});
await uploadManifest(manifest);
console.log(
  `\n${dry ? "DRY RUN, nothing published. Would publish" : "Published"} ${version} on ${channel}.\nInstaller: ${installerUrl}\nManifest:  ${downloadUrl(channelTag, MANIFEST)}`,
);

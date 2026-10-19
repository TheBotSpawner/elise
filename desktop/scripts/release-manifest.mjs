// ELISE Desktop release manifest (ADR-082). Adds (or updates) one release in the canonical
// manifest the web download page reads — built from the same Forge output the auto-updater
// serves (Squirrel RELEASES + nupkg live next to the installer).
//
//   node desktop/scripts/release-manifest.mjs \
//     --installer desktop/out/make/squirrel.windows/x64/ELISE-Setup.exe \
//     --base-url https://github.com/<owner>/<repo>/releases/download/desktop-v0.2.0 \
//     --channel beta --state published [--signed] [--out desktop/out/desktop-releases.json]
//
// States: draft (built, offered to nobody), published, withdrawn (never offered again).
// Withdraw:  --withdraw 0.2.0 --out <manifest>
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

const args = process.argv.slice(2);
const opt = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const flag = (name) => args.includes(`--${name}`);

const out = opt("out", "desktop/out/desktop-releases.json");
const manifest = existsSync(out)
  ? JSON.parse(readFileSync(out, "utf8"))
  : { schemaVersion: 1, releases: [] };

const withdraw = opt("withdraw");
if (withdraw) {
  const hits = manifest.releases.filter((r) => r.version === withdraw);
  if (!hits.length) throw new Error(`No release ${withdraw} in ${out}`);
  for (const r of hits) r.state = "withdrawn";
  writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Withdrew ${withdraw} (${hits.length} build(s)).`);
  process.exit(0);
}

const installer = opt("installer");
const baseUrl = opt("base-url");
if (!installer || !baseUrl) throw new Error("--installer and --base-url are required");
const channel = opt("channel", "stable");
const state = opt("state", "draft");
const signed = flag("signed");
if (!["stable", "beta"].includes(channel)) throw new Error("--channel stable|beta");
if (!["draft", "published", "withdrawn"].includes(state))
  throw new Error("--state draft|published|withdrawn");
if (channel === "stable" && state === "published" && !signed)
  throw new Error(
    "A published stable release must be signed (use --channel beta for unsigned builds)",
  );

const version = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;
const hash = createHash("sha256");
await new Promise((resolve, reject) =>
  createReadStream(installer)
    .on("data", (c) => hash.update(c))
    .on("end", resolve)
    .on("error", reject),
);

const entry = {
  version,
  channel,
  state,
  platform: "windows",
  arch: "x64",
  installerUrl: `${baseUrl.replace(/\/$/, "")}/${encodeURIComponent(basename(installer))}`,
  sha256: hash.digest("hex"),
  sizeBytes: statSync(installer).size,
  publishedAt: new Date().toISOString(),
  signed,
  minimumSupportedBridgeProtocol: 1,
};
manifest.releases = [
  ...manifest.releases.filter(
    (r) => !(r.version === version && r.platform === entry.platform && r.arch === entry.arch),
  ),
  entry,
];
writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(
  `${out}: ${entry.platform}/${entry.arch} ${version} (${channel}, ${state}) sha256 ${entry.sha256}`,
);

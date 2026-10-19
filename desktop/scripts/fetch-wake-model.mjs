// The wake word's model for ELISE Desktop (ADR-095): Vosk's small Spanish model (Apache-2.0,
// AC Technologies / Alpha Cephei), downloaded once, checked against a pinned SHA-256 and repacked
// as the .tar.gz the in-app recognizer loads. It ships inside the installer (assets/wake); it is
// never fetched by the app at runtime and never committed to git.
//
//   node desktop/scripts/fetch-wake-model.mjs     (also run by Forge before packaging)
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const WAKE_MODEL = {
  name: "vosk-model-small-es-0.42",
  url: "https://alphacephei.com/vosk/models/vosk-model-small-es-0.42.zip",
  sha256: "09b239888f633ef2f0b4e09736e3d9936acfd810bc65d53fad45261762c6511f",
  license: "Apache-2.0",
};

const DIR = fileURLToPath(new URL("../assets/wake/", import.meta.url));
const OUT = join(DIR, `${WAKE_MODEL.name}.tar.gz`);
// Windows' own bsdtar reads zip and writes tar.gz; elsewhere unzip + tar.
const TAR =
  process.platform === "win32"
    ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
    : "tar";

export async function ensureWakeModel() {
  if (existsSync(OUT)) return OUT;
  mkdirSync(DIR, { recursive: true });
  const work = mkdtempSync(join(tmpdir(), "elise-wake-"));
  try {
    console.log(`• downloading ${WAKE_MODEL.url}`);
    const res = await fetch(WAKE_MODEL.url);
    if (!res.ok) throw new Error(`model download failed: ${res.status}`);
    const zip = Buffer.from(await res.arrayBuffer());
    const sum = createHash("sha256").update(zip).digest("hex");
    if (sum !== WAKE_MODEL.sha256)
      throw new Error(`model checksum ${sum} ≠ pinned ${WAKE_MODEL.sha256}`);
    writeFileSync(join(work, "model.zip"), zip);
    if (process.platform === "win32") execFileSync(TAR, ["-xf", "model.zip"], { cwd: work });
    else execFileSync("unzip", ["-q", "model.zip"], { cwd: work });
    execFileSync(TAR, ["-czf", OUT, WAKE_MODEL.name], { cwd: work });
    writeFileSync(
      join(DIR, "LICENSE.txt"),
      `${WAKE_MODEL.name} — ${WAKE_MODEL.license}\nSource: ${WAKE_MODEL.url}\nCopyright AC Technologies LLC (Alpha Cephei). Apache License 2.0: https://www.apache.org/licenses/LICENSE-2.0\n`,
    );
    console.log(`• wake model ready: ${OUT} (${(readFileSync(OUT).length / 1e6).toFixed(1)} MB)`);
    return OUT;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await ensureWakeModel();

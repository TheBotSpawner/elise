import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { rename, rm, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import type { HomeRuntimeProgress } from "@/core/home/runtime";

import { RuntimeError } from "./backend";

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

/**
 * Downloads a pinned artifact (ADR-082): https only, resumable (HTTP Range into `<file>.part`),
 * a few retries, then SHA-256 verified before it's ever used. A mismatch deletes the file:
 * an unverified artifact never reaches the next step.
 */
export async function downloadVerified(options: {
  url: string;
  sha256: string;
  sizeBytes: number;
  file: string;
  onProgress: (p: HomeRuntimeProgress) => void;
  fetchImpl?: typeof fetch;
  retries?: number;
}): Promise<string> {
  const { url, sha256, sizeBytes, file, onProgress } = options;
  const doFetch = options.fetchImpl ?? fetch;
  if (!url.startsWith("https://"))
    throw new RuntimeError("HOME_RUNTIME_DOWNLOAD_FAILED", "https only");

  // Already downloaded and intact (a previous run got this far).
  if (
    (await stat(file).catch(() => null))?.size === sizeBytes &&
    (await sha256File(file)) === sha256
  )
    return file;

  const part = `${file}.part`;
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= (options.retries ?? 3); attempt++) {
    try {
      const have = (await stat(part).catch(() => null))?.size ?? 0;
      if (have < sizeBytes) {
        const res = await doFetch(url, {
          headers: have ? { range: `bytes=${have}-` } : {},
          signal: AbortSignal.timeout(10 * 60_000),
        });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        // The server ignored Range: start over rather than append twice.
        const resumed = have > 0 && res.status === 206;
        let received = resumed ? have : 0;
        const counter = new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, ctl) {
            received += chunk.byteLength;
            onProgress({
              stage: "downloading_base",
              receivedBytes: received,
              totalBytes: sizeBytes,
            });
            ctl.enqueue(chunk);
          },
        });
        await pipeline(
          Readable.fromWeb(res.body.pipeThrough(counter) as never),
          createWriteStream(part, { flags: resumed ? "a" : "w" }),
        );
      }
      onProgress({ stage: "verifying" });
      if ((await sha256File(part)) !== sha256) {
        await rm(part, { force: true });
        throw new RuntimeError("HOME_RUNTIME_VERIFY_FAILED", "checksum mismatch");
      }
      await rename(part, file);
      return file;
    } catch (e) {
      lastError = e;
      if (e instanceof RuntimeError) throw e; // a bad artifact isn't fixed by retrying
      await new Promise((r) => setTimeout(r, Math.min(1000 * 2 ** attempt, 15_000)));
    }
  }
  throw new RuntimeError(
    "HOME_RUNTIME_DOWNLOAD_FAILED",
    lastError instanceof Error ? lastError.message : "download failed",
  );
}

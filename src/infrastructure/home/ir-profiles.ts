import "server-only";

import { AppError } from "@/core/errors";
import {
  IR_PROFILE_KINDS,
  parseProfileIndex,
  type ProfileEntry,
  type ProfileKind,
} from "@/core/home/ir-profiles";

/**
 * SmartIR's public code library (ADR-117, MIT): its docs index per device class and one JSON
 * per profile, read from GitHub's raw files (no API key, no rate limit for raw). Cached: the
 * index for a day, each profile for a day. Nothing of the person's is sent.
 */

const RAW = "https://raw.githubusercontent.com/smartHomeHub/SmartIR/master";
const DAY = 24 * 60 * 60_000;
const TIMEOUT_MS = 8_000;
const DOCS: Record<ProfileKind, string> = { tv: "MEDIA_PLAYER", ac: "CLIMATE", fan: "FAN" };

const indexes = new Map<ProfileKind, { at: number; entries: ProfileEntry[] }>();
const profiles = new Map<string, { at: number; json: unknown }>();

async function get(path: string): Promise<Response> {
  const res = await fetch(`${RAW}/${path}`, { signal: AbortSignal.timeout(TIMEOUT_MS) }).catch(
    (cause: unknown) => {
      throw new AppError("PROVIDER_UNAVAILABLE", "The profile library didn't respond", { cause });
    },
  );
  if (!res.ok)
    throw new AppError(
      res.status === 404 ? "NOT_FOUND" : "PROVIDER_UNAVAILABLE",
      "That profile isn't available",
    );
  return res;
}

export async function profileIndex(kind: ProfileKind): Promise<ProfileEntry[]> {
  const hit = indexes.get(kind);
  if (hit && Date.now() - hit.at < DAY) return hit.entries;
  const entries = parseProfileIndex(await (await get(`docs/${DOCS[kind]}.md`)).text());
  indexes.set(kind, { at: Date.now(), entries });
  return entries;
}

export async function profileFile(kind: ProfileKind, code: number): Promise<unknown> {
  const key = `${kind}:${code}`;
  const hit = profiles.get(key);
  if (hit && Date.now() - hit.at < DAY) return hit.json;
  const res = await get(`codes/${IR_PROFILE_KINDS[kind]}/${code}.json`);
  if (Number(res.headers.get("content-length") ?? 0) > 2_000_000)
    throw new AppError("VALIDATION_ERROR", "That profile is too large");
  const json: unknown = await res.json();
  profiles.set(key, { at: Date.now(), json });
  return json;
}

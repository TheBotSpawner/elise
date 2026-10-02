import "server-only";

import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import http from "node:http";
import https from "node:https";
import type { LookupFunction } from "node:net";
import zlib from "node:zlib";

import { AppError } from "@/core/errors";
import { extractPage, normalizeDate } from "@/core/web/extract";
import { extractItems, itemLinks, readLimitation } from "@/core/web/items";
import { WEB_LIMITS, type WebPage } from "@/core/web/model";
import { checkUrl, cleanUrl, domainOf, isPrivateAddress } from "@/core/web/url";

/**
 * Server-side page reading with SSRF protection (ADR-015):
 * - only public http(s) URLs (core/web/url.ts), re-checked on every redirect (max 4);
 * - every IP the hostname resolves to is checked *inside the socket's DNS lookup*, so the
 *   address that is validated is the address that is connected to (no DNS-rebinding window);
 * - bounded time and size, HTML/text only, no cookies, no credentials, no auth headers.
 * The text is untrusted data.
 */

const ACCEPTED = /^(text\/html|application\/xhtml\+xml|text\/plain|text\/markdown)\b/i;
const UA = "Mozilla/5.0 (compatible; ELISE/1.0; +https://elise.app/bot) research assistant";

const safeLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error, "", 0);
    const list = (Array.isArray(addresses) ? addresses : [addresses]) as LookupAddress[];
    const blocked = list.find((a) => isPrivateAddress(a.address));
    if (!list.length || blocked) {
      return callback(Object.assign(new Error("Blocked address"), { code: "EBLOCKED" }), "", 0);
    }
    if ((options as { all?: boolean }).all)
      return (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, list);
    callback(null, list[0]!.address, list[0]!.family);
  });
};

interface RawResponse {
  status: number;
  location: string | null;
  contentType: string;
  body: Buffer;
  truncated: boolean;
}

function request(url: URL, signal: AbortSignal): Promise<RawResponse> {
  const lib = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request(
      url,
      {
        method: "GET",
        lookup: safeLookup,
        signal,
        headers: {
          "user-agent": UA,
          accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1",
          "accept-encoding": "gzip, deflate, br",
          "accept-language": "es,en;q=0.8",
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const location = typeof res.headers.location === "string" ? res.headers.location : null;
        const contentType = String(res.headers["content-type"] ?? "");
        if (status >= 300 && status < 400) {
          res.resume();
          return resolve({
            status,
            location,
            contentType,
            body: Buffer.alloc(0),
            truncated: false,
          });
        }
        const encoding = String(res.headers["content-encoding"] ?? "").toLowerCase();
        const stream =
          encoding === "gzip"
            ? res.pipe(zlib.createGunzip())
            : encoding === "deflate"
              ? res.pipe(zlib.createInflate())
              : encoding === "br"
                ? res.pipe(zlib.createBrotliDecompress())
                : res;
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        stream.on("data", (chunk: Buffer) => {
          if (truncated) return;
          size += chunk.length;
          if (size > WEB_LIMITS.pageBytes) {
            truncated = true;
            chunks.push(chunk.subarray(0, chunk.length - (size - WEB_LIMITS.pageBytes)));
            res.destroy();
            resolve({ status, location, contentType, body: Buffer.concat(chunks), truncated });
            return;
          }
          chunks.push(chunk);
        });
        stream.on("end", () =>
          resolve({ status, location, contentType, body: Buffer.concat(chunks), truncated }),
        );
        stream.on("error", (e) => (truncated ? undefined : reject(e)));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function decode(body: Buffer, contentType: string): string {
  const charset = /charset=["']?([\w-]+)/i.exec(contentType)?.[1]?.toLowerCase();
  const sniffed = !charset
    ? /<meta[^>]+charset=["']?([\w-]+)/i.exec(body.subarray(0, 2048).toString("latin1"))?.[1]
    : null;
  try {
    return new TextDecoder(charset ?? sniffed ?? "utf-8", { fatal: false }).decode(body);
  } catch {
    return body.toString("utf8");
  }
}

/** Reads one public page; throws AppError with an honest reason when it can't. */
export async function fetchPage(rawUrl: string): Promise<WebPage> {
  const retrievedAt = new Date().toISOString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEB_LIMITS.fetchTimeoutMs);
  try {
    let current = rawUrl;
    for (let hop = 0; hop <= WEB_LIMITS.maxRedirects; hop++) {
      const check = checkUrl(current);
      if (!check.ok)
        throw new AppError("VALIDATION_ERROR", `Blocked link: ${check.reason}`, {
          recovery: "review",
        });
      let res: RawResponse;
      try {
        res = await request(check.url, controller.signal);
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === "EBLOCKED")
          throw new AppError("VALIDATION_ERROR", "Blocked link: not a public address", {
            recovery: "review",
          });
        throw new AppError(
          "PROVIDER_UNAVAILABLE",
          controller.signal.aborted ? "The page took too long" : "The page couldn't be reached",
          {
            recovery: "retry",
          },
        );
      }
      if (res.status >= 300 && res.status < 400 && res.location) {
        current = new URL(res.location, check.url).toString();
        continue;
      }
      if (res.status === 401 || res.status === 403 || res.status === 429)
        throw new AppError("PERMISSION_DENIED", "The site doesn't allow reading this page", {
          recovery: "review",
          details: { limitation: "blocked" },
        });
      if (res.status >= 400)
        throw new AppError("NOT_FOUND", `The page answered ${res.status}`, { recovery: "review" });
      if (res.contentType && !ACCEPTED.test(res.contentType))
        throw new AppError("VALIDATION_ERROR", "Not a readable web page", { recovery: "review" });
      const raw = decode(res.body, res.contentType);
      const isHtml = !res.contentType || /html/i.test(res.contentType);
      const extracted = isHtml
        ? extractPage(raw)
        : {
            title: "",
            siteName: null,
            description: null,
            publishedAt: null,
            canonicalUrl: null,
            text: raw.trim(),
          };
      const finalUrl = cleanUrl(check.url.toString());
      // Structured items (schema.org JSON-LD) are read even where the visible text is thin.
      const items = isHtml ? extractItems(raw, finalUrl) : [];
      const limitation = isHtml ? readLimitation(raw, extracted.text, rawUrl, finalUrl) : null;
      // A verification page that answered 200 is not the page: say what really happened.
      if (limitation && !items.length)
        throw limitation === "blocked"
          ? new AppError("PERMISSION_DENIED", "The site blocks automated reading of this page", {
              recovery: "review",
              details: { limitation },
            })
          : new AppError("NOT_FOUND", "This page only shows its content in a browser", {
              recovery: "review",
              details: { limitation },
            });
      const text = (
        extracted.text.trim() ? extracted.text : items.map((i) => `• ${i.title}`).join("\n")
      ).slice(0, WEB_LIMITS.pageChars);
      if (!text.trim())
        throw new AppError("NOT_FOUND", "The page has no readable text", { recovery: "review" });
      return {
        requestedUrl: rawUrl,
        url: finalUrl,
        domain: domainOf(finalUrl),
        title: extracted.title || domainOf(finalUrl),
        siteName: extracted.siteName,
        description: extracted.description,
        publishedAt: normalizeDate(extracted.publishedAt),
        retrievedAt,
        text,
        truncated: res.truncated || extracted.text.length > WEB_LIMITS.pageChars,
        ...(items.length ? { items } : {}),
        ...(isHtml && !items.length ? { itemLinks: itemLinks(raw, finalUrl) } : {}),
      };
    }
    throw new AppError("NOT_FOUND", "Too many redirects", { recovery: "review" });
  } finally {
    clearTimeout(timer);
  }
}

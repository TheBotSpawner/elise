/**
 * URL safety for server-side fetching (ADR-015). Only public http(s) pages: no other schemes,
 * no credentials in URLs, no non-standard ports, no localhost, private, link-local or
 * cloud-metadata addresses. The fetcher re-checks every resolved IP and every redirect.
 */

export type UrlCheck = { ok: true; url: URL } | { ok: false; reason: string };

const BLOCKED_HOSTS = /(^|\.)(localhost|local|localdomain|internal|intranet|lan|home|corp|arpa)$/i;
const METADATA_HOSTS = new Set(["metadata.google.internal", "metadata", "instance-data"]);

export function checkUrl(raw: string): UrlCheck {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, reason: "Not a valid URL" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    return { ok: false, reason: `The ${url.protocol} scheme isn't allowed` };
  if (url.username || url.password)
    return { ok: false, reason: "URLs with credentials aren't allowed" };
  if (url.port && url.port !== "80" && url.port !== "443")
    return { ok: false, reason: "Only standard ports" };
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host || (!host.includes(".") && !isIpLiteral(host)))
    return { ok: false, reason: "Not a public host" };
  if (BLOCKED_HOSTS.test(host) || METADATA_HOSTS.has(host))
    return { ok: false, reason: "Not a public host" };
  if (isIpLiteral(host) && isPrivateAddress(host))
    return { ok: false, reason: "Private addresses aren't allowed" };
  return { ok: true, url };
}

const isIpLiteral = (host: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":");

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255))
    return null;
  return ((parts[0]! << 24) >>> 0) + (parts[1]! << 16) + (parts[2]! << 8) + parts[3]!;
}

const V4_BLOCKED: [string, number][] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

/** Loopback, private, link-local, shared, reserved, multicast (v4 and v6, incl. mapped v4). */
export function isPrivateAddress(ip: string): boolean {
  const addr = ip.replace(/^\[|\]$/g, "").toLowerCase();
  const v4 = ipv4ToInt(addr);
  if (v4 !== null) {
    return V4_BLOCKED.some(([base, bits]) => {
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      return (v4 & mask) >>> 0 === (ipv4ToInt(base)! & mask) >>> 0;
    });
  }
  if (!addr.includes(":")) return true; // not an IP we understand: refuse
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(addr);
  if (mapped) return isPrivateAddress(mapped[1]!);
  // The URL parser writes mapped IPv4 in hex (::ffff:7f00:1 = 127.0.0.1).
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(addr);
  if (hex) {
    const hi = parseInt(hex[1]!, 16);
    const lo = parseInt(hex[2]!, 16);
    return isPrivateAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  if (addr === "::" || addr === "::1") return true;
  const first = parseInt(addr.split(":")[0] || "0", 16);
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((first & 0xff00) === 0xff00) return true; // multicast
  if (addr.startsWith("64:ff9b:") || addr.startsWith("2001:db8:")) return true;
  return false;
}

const TRACKING = /^(utm_[a-z]+|fbclid|gclid|mc_[a-z]+|ref|ref_src|igshid|si)$/i;

/** One key per page: no tracking parameters, fragment, or trailing slash. */
export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = "";
    for (const key of [...u.searchParams.keys()])
      if (TRACKING.test(key)) u.searchParams.delete(key);
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, "");
    if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, "");
    return u.toString().replace(/\/$/, "");
  } catch {
    return raw;
  }
}

/** The URL as the user should see and open it (tracking parameters removed). */
export function cleanUrl(raw: string): string {
  try {
    const u = new URL(raw);
    for (const key of [...u.searchParams.keys()])
      if (TRACKING.test(key)) u.searchParams.delete(key);
    return u.toString();
  } catch {
    return raw;
  }
}

export function domainOf(raw: string): string {
  try {
    return new URL(raw).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

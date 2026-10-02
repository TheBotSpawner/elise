import { EventEmitter } from "node:events";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { isPrivateAddress } from "@/core/web/url";

/**
 * SSRF regressions for the page fetcher: redirects into internal hosts and hostnames that
 * resolve to private addresses (DNS rebinding) are refused. node:dns and node:http are faked;
 * the fake request performs the real `lookup` option the fetcher passes, like Node does.
 */
const DNS: Record<string, string> = {
  "public.example": "93.184.216.34",
  "rebind.example": "10.0.0.7",
  "redirect-to-rebind.example": "93.184.216.35",
};
const ROUTES: Record<string, { status: number; location?: string }> = {
  "public.example": { status: 302, location: "http://169.254.169.254/latest/meta-data/" },
  "redirect-to-rebind.example": { status: 301, location: "http://rebind.example/" },
};

const requested: string[] = [];

vi.mock("node:dns", () => ({
  lookup: (
    host: string,
    _opts: unknown,
    cb: (e: Error | null, a: { address: string; family: number }[]) => void,
  ) => cb(null, [{ address: DNS[host] ?? "8.8.8.8", family: 4 }]),
}));

vi.mock("node:http", () => {
  const request = (
    url: URL,
    options: {
      lookup: (h: string, o: object, cb: (e: Error | null, a?: unknown) => void) => void;
    },
    onResponse: (res: unknown) => void,
  ) => {
    const req = new EventEmitter() as EventEmitter & { end: () => void };
    req.end = () =>
      options.lookup(url.hostname, {}, (error) => {
        if (error) return req.emit("error", error);
        requested.push(url.hostname);
        const route = ROUTES[url.hostname] ?? { status: 200 };
        const res = Object.assign(new EventEmitter(), {
          statusCode: route.status,
          headers: { location: route.location, "content-type": "text/html" },
          resume: () => {},
        });
        onResponse(res);
        queueMicrotask(() => res.emit("end"));
      });
    return req;
  };
  return { default: { request }, request };
});

beforeEach(() => {
  requested.length = 0;
});

describe("web fetcher SSRF", () => {
  it("refuses a redirect to a metadata endpoint", async () => {
    const { fetchPage } = await import("@/infrastructure/web/fetcher");
    await expect(fetchPage("http://public.example/")).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    expect(requested).toEqual(["public.example"]);
  });

  it("refuses a hostname that resolves to a private address", async () => {
    const { fetchPage } = await import("@/infrastructure/web/fetcher");
    await expect(fetchPage("http://rebind.example/")).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    expect(requested).toEqual([]);
  });

  it("refuses a redirect to a hostname that resolves privately", async () => {
    const { fetchPage } = await import("@/infrastructure/web/fetcher");
    await expect(fetchPage("http://redirect-to-rebind.example/")).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    expect(requested).toEqual(["redirect-to-rebind.example"]);
  });

  it("treats IPv6 tunnels to IPv4 as private", () => {
    for (const ip of ["2002:7f00:1::", "2001:0:4136:e378::1", "2001::1", "::7f00:1", "100::1"])
      expect(isPrivateAddress(ip), ip).toBe(true);
    expect(isPrivateAddress("2606:4700::6810:84e5")).toBe(false);
  });
});

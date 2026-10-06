import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV === "development";
const supabase = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const supabaseWs = supabase.replace(/^http/, "ws");
// Location (ADR-023): the Maps JavaScript API loads from Google's hosts, only when configured.
const maps = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY
  ? {
      script: " https://maps.googleapis.com https://*.gstatic.com",
      connect: " https://*.googleapis.com https://*.gstatic.com https://*.google.com",
      font: " https://fonts.gstatic.com",
      style: " https://fonts.googleapis.com",
    }
  : { script: "", connect: "", font: "", style: "" };

/**
 * Security headers (docs/engineering/17). CSP without nonces: Next.js inline bootstrap scripts
 * need 'unsafe-inline' unless every page renders dynamically with a nonce. The browser only
 * talks to this app and Supabase (REST, Auth, Realtime), plus the Maps JavaScript API when it is
 * configured (restricted browser key; places and routes stay server-side).
 * form-action allows the OAuth consent hosts that server actions redirect to.
 */
const csp = [
  "default-src 'self'",
  // Music (ADR-042/044): the official YouTube IFrame Player API script (iframe_api and the
  // widget API it loads); the player itself is framed from youtube-nocookie.com, below.
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""} https://www.youtube.com${maps.script}`,
  `style-src 'self' 'unsafe-inline'${maps.style}`,
  "img-src 'self' blob: data: https:",
  `font-src 'self' data:${maps.font}`,
  `connect-src 'self' ${supabase} ${supabaseWs}${maps.connect}`.trim(),
  "media-src 'self' blob:",
  // Video Surfaces (ADR-021): only these players, only by id (core/workspace/media.ts).
  "frame-src https://www.youtube-nocookie.com https://player.vimeo.com",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  `form-action 'self' ${supabase} https://accounts.google.com https://api.notion.com`.trim(),
  "frame-ancestors 'none'",
  ...(isDev ? [] : ["upgrade-insecure-requests"]),
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Voice needs the microphone and Location the position (asked, per session) on ELISE's own
  // origin only; nothing else is granted.
  {
    key: "Permissions-Policy",
    value: "microphone=(self), camera=(), geolocation=(self), payment=(), usb=()",
  },
  ...(isDev
    ? []
    : [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" }]),
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
};

export default nextConfig;

import { Check, Download } from "lucide-react";
import { headers } from "next/headers";
import Link from "next/link";

import { requireAuthContext } from "@/application/auth-context";
import { isAdmin } from "@/application/usage-service";
import { BackLink } from "@/components/shared/back-link";
import { PageContainer } from "@/components/shared/page";
import { buttonVariants } from "@/components/ui/button";
import {
  desktopReleaseFor,
  desktopReleases,
  DESKTOP_PLATFORMS,
  platformFromUserAgent,
  type DesktopPlatform,
} from "@/config/desktop-releases";
import { getT } from "@/lib/i18n/server";
import { cn } from "@/lib/utils";

const size = (bytes: number | undefined) => (bytes ? `${Math.round(bytes / 1024 ** 2)} MB` : null);

/**
 * ELISE Desktop (ADR-081/082): the build for this computer first, the others one tap away, and
 * back to Hogar when setup started there. Builds come from the release manifest — the same one
 * the updater follows; with none for this audience the page says so instead of a fake link.
 */
export default async function DesktopDownloadPage({
  searchParams,
}: PageProps<"/download/desktop">) {
  const [{ t }, h, params, auth] = await Promise.all([
    getT(),
    headers(),
    searchParams,
    requireAuthContext(),
  ]);
  const tester = { tester: isAdmin(auth) };
  const d = t.download;
  const chosen =
    typeof params.os === "string" && (DESKTOP_PLATFORMS as readonly string[]).includes(params.os)
      ? (params.os as DesktopPlatform)
      : null;
  const platform = chosen ?? platformFromUserAgent(h.get("user-agent"));
  const [main, all] = await Promise.all([
    platform ? desktopReleaseFor(platform, tester) : null,
    desktopReleases(tester),
  ]);
  const release = main ?? (platform ? null : (all[0] ?? null));
  const fromHome = params.from === "home";
  // Only builds that exist, never the one this page is already about.
  const others = DESKTOP_PLATFORMS.filter(
    (p) => p !== (release?.platform ?? platform) && all.some((r) => r.platform === p),
  );

  return (
    <PageContainer>
      <div className="mx-auto flex max-w-2xl flex-col gap-8 py-4 md:py-10">
        {fromHome && <BackLink href="/my-elise/home" label={d.back} />}
        <section className="flex flex-col gap-6 rounded-3xl border border-border bg-surface px-6 py-8 sm:px-10 sm:py-10">
          <div className="flex flex-col gap-2">
            <p className="text-[12px] font-medium tracking-[0.3em] text-muted uppercase">
              {d.title}
            </p>
            <h1 className="text-[30px] leading-tight font-light tracking-[-0.025em] sm:text-[36px]">
              {d.tagline}
            </h1>
          </div>
          {release ? (
            <div className="flex flex-col gap-2">
              <a
                href={release.installerUrl}
                download
                className={cn(buttonVariants({ size: "lg" }), "self-start max-sm:w-full")}
              >
                <Download aria-hidden />
                {d.cta(d.platforms[release.platform])}
              </a>
              <p className="text-[12.5px] text-faint">
                {d.meta(release.arch, release.version, size(release.sizeBytes))}
              </p>
              {release.channel === "beta" && !release.signed && (
                <p className="text-[12.5px] text-muted">{d.betaNote}</p>
              )}
              <p className="text-[13.5px] text-muted">{d.afterDownload}</p>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <p className="text-[16px]">
                {platform ? d.unavailableFor(d.platforms[platform]) : d.unavailable}
              </p>
              <p className="text-[14px] text-muted">{d.unavailableBody}</p>
            </div>
          )}
          <ul className="flex flex-col gap-2.5 border-t border-border pt-6">
            {d.benefits.map((b) => (
              <li key={b} className="flex items-center gap-2.5 text-[14.5px] text-muted">
                <Check className="size-4 shrink-0 text-success" aria-hidden />
                {b}
              </li>
            ))}
          </ul>
        </section>
        {others.length > 0 && (
          <p className="text-[13.5px] text-muted">
            {d.others}{" "}
            {others.map((p, i) => (
              <span key={p}>
                {i > 0 && " · "}
                <Link
                  href={`/download/desktop?os=${p}${fromHome ? "&from=home" : ""}`}
                  className="text-accent-text hover:underline"
                >
                  {d.platforms[p]}
                </Link>
              </span>
            ))}
          </p>
        )}
      </div>
    </PageContainer>
  );
}

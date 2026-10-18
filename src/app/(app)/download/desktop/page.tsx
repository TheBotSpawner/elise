import { Download } from "lucide-react";
import { headers } from "next/headers";

import { BackLink } from "@/components/shared/back-link";
import { PageContainer } from "@/components/shared/page";
import { buttonVariants } from "@/components/ui/button";
import {
  desktopReleases,
  DESKTOP_PLATFORMS,
  platformFromUserAgent,
  type DesktopPlatform,
} from "@/config/desktop-releases";
import { getT } from "@/lib/i18n/server";

/**
 * ELISE Desktop (ADR-080): the matching build first, the others below, one sentence on why —
 * and back to Hogar. Builds come from release configuration; with none configured the page
 * says Desktop isn't available yet instead of offering a fake download.
 */
export default async function DesktopDownloadPage({
  searchParams,
}: PageProps<"/download/desktop">) {
  const [{ t }, h, params] = await Promise.all([getT(), headers(), searchParams]);
  const d = t.download;
  const releases = desktopReleases();
  const detected = platformFromUserAgent(h.get("user-agent"));
  const wanted = (
    typeof params.os === "string" && (DESKTOP_PLATFORMS as readonly string[]).includes(params.os)
      ? params.os
      : detected
  ) as DesktopPlatform | null;
  const main = releases.find((r) => r.platform === wanted) ?? releases[0] ?? null;
  const others = releases.filter((r) => r !== main);
  return (
    <PageContainer>
      <div className="mx-auto flex max-w-xl flex-col gap-6 py-6">
        {params.from === "home" && <BackLink href="/my-elise/home" label={d.back} />}
        {main ? (
          <section className="flex flex-col items-start gap-4">
            <h1 className="text-[26px] font-light tracking-[-0.02em]">
              {d.forPlatform(d.platforms[main.platform])}
            </h1>
            <p className="text-[14.5px] text-muted">{d.why}</p>
            <a href={main.downloadUrl} className={buttonVariants({ size: "lg" })}>
              <Download />
              {d.cta(d.platforms[main.platform])}
            </a>
            <p className="text-[12.5px] text-faint">{d.version(main.version)}</p>
            {others.length > 0 && (
              <p className="text-[13.5px] text-muted">
                {d.others}{" "}
                {others.map((r, i) => (
                  <span key={`${r.platform}-${r.architecture ?? ""}`}>
                    {i > 0 && " · "}
                    <a href={r.downloadUrl} className="text-accent-text hover:underline">
                      {d.platforms[r.platform]}
                      {r.architecture ? ` (${r.architecture})` : ""}
                    </a>
                  </span>
                ))}
              </p>
            )}
          </section>
        ) : (
          <section className="flex flex-col items-start gap-3">
            <h1 className="text-[22px] font-light tracking-[-0.02em]">{d.unavailable}</h1>
            <p className="text-[14.5px] text-muted">{d.why}</p>
            <p className="text-[14px] text-muted">{d.unavailableBody}</p>
          </section>
        )}
      </div>
    </PageContainer>
  );
}

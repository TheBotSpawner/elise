"use client";

import { Check, Download } from "lucide-react";
import Link from "next/link";

import { BackLink } from "@/components/shared/back-link";
import { PageContainer } from "@/components/shared/page";
import { buttonVariants } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

import type { DesktopDownloadProps } from "./load";

const size = (bytes: number | undefined) => (bytes ? `${Math.round(bytes / 1024 ** 2)} MB` : null);

export function View({ release, platform, others, fromHome }: DesktopDownloadProps) {
  const { t } = useI18n();
  const d = t.download;

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

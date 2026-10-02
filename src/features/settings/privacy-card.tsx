import Link from "next/link";

import { Card } from "@/components/ui/card";
import type { Dictionary } from "@/lib/i18n";

/**
 * What ELISE keeps and how to remove it, in plain words (ADR-019). Every sentence describes
 * what the backend actually does; nothing here promises more.
 */
export function PrivacyCard({ t }: { t: Dictionary }) {
  const p = t.settings.privacy;
  const rows = [
    { title: p.historyTitle, body: p.historyBody, href: "/chat" },
    { title: p.voiceTitle, body: p.voiceBody, href: null },
    { title: p.connectionsTitle, body: p.connectionsBody, href: "/connections" },
    { title: p.knowledgeTitle, body: p.knowledgeBody, href: "/knowledge" },
    { title: p.webTitle, body: p.webBody, href: null },
  ];
  return (
    <Card className="p-5">
      <h2 className="mb-4 font-medium">{p.title}</h2>
      <dl className="flex flex-col gap-4">
        {rows.map((row) => (
          <div key={row.title}>
            <dt className="text-sm font-medium">
              {row.href ? (
                <Link href={row.href} className="hover:text-accent-text">
                  {row.title}
                </Link>
              ) : (
                row.title
              )}
            </dt>
            <dd className="mt-0.5 text-[13.5px] text-muted">{row.body}</dd>
          </div>
        ))}
      </dl>
      <Link
        href="/onboarding?again=1"
        className="mt-5 inline-flex min-h-11 items-center text-[13.5px] text-accent-text hover:underline"
      >
        {t.onboarding.again}
      </Link>
    </Card>
  );
}

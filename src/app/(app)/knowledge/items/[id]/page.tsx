import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";

import { requireAuthContext } from "@/application/auth-context";
import { getItemPreview } from "@/application/knowledge-service";
import { knowledgeItemText } from "@/application/methods-service";
import { PageContainer } from "@/components/shared/page";
import { buttonVariants } from "@/components/ui/button";
import { looksProcedural } from "@/core/skills/model";
import { getT } from "@/lib/i18n/server";

/**
 * Source preview for a citation: metadata, the cited passage, versions and a way to the
 * original (signed download for uploads, provider link for Drive/Notion). Not an editor.
 */
export default async function KnowledgeItemPage({
  params,
  searchParams,
}: PageProps<"/knowledge/items/[id]">) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  if (!z.uuid().safeParse(id).success) notFound();
  const chunk =
    typeof query.chunk === "string" && z.uuid().safeParse(query.chunk).success ? query.chunk : null;
  const [auth, { t, locale }] = await Promise.all([requireAuthContext(), getT()]);
  const [data, doc] = await Promise.all([
    getItemPreview(auth, id, chunk).catch(() => null),
    knowledgeItemText(auth, id).catch(() => null),
  ]);
  if (!data) notFound();
  // A document that reads like a procedure can become a Method (ADR-040 §J3) — offered, never
  // assumed: Knowledge stays Knowledge.
  const procedural = Boolean(doc && looksProcedural(doc.text));
  const { item, versions, passage } = data;
  const format = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeZone: auth.profile.timezone,
  });

  return (
    <PageContainer>
      <article className="mx-auto flex max-w-[720px] flex-col gap-6">
        <header className="flex flex-col gap-2">
          {item.space && (
            <Link
              href={`/knowledge/spaces/${item.space.id}`}
              className="text-[13px] text-muted hover:text-fg"
            >
              ← {item.space.path}
            </Link>
          )}
          <h1 className="text-[26px] leading-[1.2] font-light tracking-[-0.02em]">{item.title}</h1>
          <p className="text-[13px] text-muted">
            {t.knowledge.sourceTypes[item.sourceType]}
            {item.path.length > 0 && ` · ${item.path.join(" › ")}`} ·{" "}
            {t.knowledge.status[item.status]}
          </p>
          <div className="flex flex-wrap gap-2 pt-1">
            {item.url && (
              <a
                href={item.url}
                target="_blank"
                rel="noopener noreferrer"
                className={buttonVariants({ size: "sm", variant: "secondary" })}
              >
                {t.knowledge.item.openOriginal}
              </a>
            )}
            {item.downloadUrl && (
              <a
                href={item.downloadUrl}
                className={buttonVariants({ size: "sm", variant: "secondary" })}
              >
                {t.knowledge.item.download}
              </a>
            )}
            {item.space && (
              <Link
                href={`/?space=${item.space.id}`}
                className={buttonVariants({ size: "sm", variant: "ghost" })}
              >
                {t.knowledge.ask}
              </Link>
            )}
          </div>
        </header>

        {procedural && (
          <section className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border bg-surface px-5 py-3">
            <p className="text-[13.5px] text-muted">{t.methods.useAsMethodHint}</p>
            <Link
              href={`/my-elise/methods?fromItem=${item.id}`}
              className={buttonVariants({ size: "sm", variant: "secondary" })}
            >
              {t.methods.useAsMethod}
            </Link>
          </section>
        )}

        {passage && (
          <section className="flex flex-col gap-2 rounded-2xl border border-accent-line bg-accent-soft px-5 py-4">
            <p className="type-label text-accent-text">
              {t.knowledge.item.passage}
              {passage.page ? ` · ${t.knowledge.item.page(passage.page)}` : ""}
              {passage.section ? ` · ${passage.section}` : ""}
            </p>
            <p className="text-[14.5px] leading-[1.6] whitespace-pre-wrap">{passage.content}</p>
          </section>
        )}

        <section className="flex flex-col gap-2">
          <h2 className="type-label text-faint">{t.knowledge.item.versions}</h2>
          <ol className="divide-y divide-border rounded-2xl border border-border bg-surface">
            {versions.map((v) => (
              <li
                key={v.id}
                className="flex items-baseline justify-between gap-3 px-5 py-2.5 text-[14px]"
              >
                <span>
                  {t.knowledge.item.version(v.number)}
                  {v.isCurrent && (
                    <span className="ml-2 type-label text-accent-text">
                      {t.knowledge.item.current}
                    </span>
                  )}
                </span>
                <span className="font-mono text-[12.5px] text-muted">
                  {format.format(new Date(v.createdAt))}
                </span>
              </li>
            ))}
          </ol>
        </section>
      </article>
    </PageContainer>
  );
}

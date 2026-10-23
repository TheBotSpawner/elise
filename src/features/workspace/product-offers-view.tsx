"use client";

import { ExternalLink, Package, Search } from "lucide-react";

import type { SurfacePayloads } from "@/core/workspace/registry";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

type Offers = SurfacePayloads["product_offers"];
type Reference = NonNullable<Offers["references"]>["others"][number];

/**
 * Products to buy (ADR-112, ADR-116): Mercado Libre's listings first, a price only where a
 * source proved it for THAT listing (official API, or Google Shopping linking it) with where and
 * when it was checked. Prices that couldn't be tied to a listing are references, in their own
 * sections — never inside a Mercado Libre card.
 */
export function ProductOffersBody({ p }: { p: Offers }) {
  const { t, locale } = useI18n();
  const x = t.offers;
  const m = p.marketplace;
  const money = (n: number, currency: string | null) =>
    currency === "ARS" || !currency
      ? `AR$ ${new Intl.NumberFormat("es-AR", { maximumFractionDigits: 0 }).format(n)}`
      : new Intl.NumberFormat(locale, { style: "currency", currency }).format(n);
  const when = (iso: string) =>
    new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
  const unpriced = m.offers.filter((o) => o.price === null).length;
  const refs = p.references;

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[12.5px] text-muted">
        <span className="font-medium text-fg2">{x.source}</span>
        {m.method === "link" && ` · ${x.viaLink}`}
        {p.maxPrice !== null && ` · ${x.upTo(money(p.maxPrice, p.currency))}`}
      </p>
      {m.offers.length > 0 && (
        <ul className="flex flex-col gap-2">
          {m.offers.map((o) => (
            <li
              key={o.url}
              className="flex gap-3 rounded-xl border border-border bg-surface px-3 py-2.5"
            >
              <Thumb src={o.image} />
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="line-clamp-2 text-[14px]">{o.title}</span>
                {o.price !== null && (
                  <span className="flex flex-col">
                    <span className="text-[18px] font-semibold tracking-[-0.01em]">
                      {money(o.price, o.currency)}
                    </span>
                    <span className="text-[11.5px] text-faint">
                      {o.priceSource === "google_shopping"
                        ? x.viaShopping(when(o.checkedAt))
                        : x.viaOfficial(when(o.checkedAt))}
                    </span>
                  </span>
                )}
                <Badges
                  condition={o.condition}
                  flagged={p.model && o.match !== "exact" ? o.match : null}
                  extra={[
                    ...(o.evidence === "api"
                      ? [o.freeShipping ? x.freeShipping : x.shippingUnknown]
                      : []),
                    ...(o.installments ? [o.installments] : []),
                    ...(o.seller ? [o.seller] : []),
                  ]}
                />
                <OpenLink href={o.url} label={x.open} />
              </div>
            </li>
          ))}
        </ul>
      )}
      {unpriced > 0 && <p className="text-[12px] text-muted">{x.unpriced(unpriced)}</p>}
      <a
        href={m.searchUrl}
        target="_blank"
        rel="noreferrer noopener"
        className="flex items-center gap-1.5 self-start rounded-full border border-border px-3 py-1.5 text-[13px] hover:border-accent-line"
      >
        <Search className="size-3.5" aria-hidden />
        {x.searchOn}
      </a>

      {refs?.marketplace.length ? (
        <ReferenceList
          title={x.marketplaceRefs}
          hint={x.marketplaceRefsHint}
          items={refs.marketplace}
          money={money}
          model={p.model ?? null}
        />
      ) : null}
      {refs?.others.length ? (
        <ReferenceList
          title={x.otherStores}
          hint={x.refsWhen(when(refs.others[0]!.checkedAt))}
          items={refs.others}
          money={money}
          model={p.model ?? null}
          showStore
        />
      ) : null}

      {p.notes.map((n) => (
        <p key={n} className="text-[12.5px] text-muted">
          {n}
        </p>
      ))}
      <p className="text-[11.5px] text-faint">{x.disclaimer}</p>
    </div>
  );
}

function Thumb({ src }: { src: string | null }) {
  return src ? (
    // Only images from the source's own image hosts (validated server-side).
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt=""
      loading="lazy"
      className="size-16 shrink-0 rounded-lg bg-white object-contain"
    />
  ) : (
    <span className="grid size-16 shrink-0 place-items-center rounded-lg bg-surface-2 text-faint">
      <Package className="size-6" aria-hidden />
    </span>
  );
}

function Badges({
  condition,
  flagged,
  extra,
}: {
  condition: "new" | "used" | null;
  flagged: "related" | "accessory" | "exact" | null;
  extra: string[];
}) {
  const { t } = useI18n();
  const x = t.offers;
  if (!condition && !flagged && !extra.length) return null;
  return (
    <span className="flex flex-wrap gap-x-2 gap-y-0.5 text-[12px] text-faint">
      {condition && <span>{condition === "used" ? x.used : x.new}</span>}
      {flagged && flagged !== "exact" && (
        <span className="text-approval-text">
          {flagged === "accessory" ? x.accessory : x.related}
        </span>
      )}
      {extra.map((e) => (
        <span key={e}>{e}</span>
      ))}
    </span>
  );
}

function OpenLink({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="flex items-center gap-1 self-start text-[13px] text-accent-text hover:underline"
    >
      {label}
      <ExternalLink className="size-3.5" aria-hidden />
    </a>
  );
}

function ReferenceList({
  title,
  hint,
  items,
  money,
  model,
  showStore = false,
}: {
  title: string;
  hint: string;
  items: Reference[];
  money: (n: number, currency: string | null) => string;
  model: string | null;
  showStore?: boolean;
}) {
  const { t } = useI18n();
  return (
    <section className="flex flex-col gap-2 border-t border-border pt-3">
      <div className="flex flex-col">
        <span className="type-label text-faint">{title}</span>
        <span className="text-[11.5px] text-faint">{hint}</span>
      </div>
      <ul className="flex flex-col gap-1.5">
        {items.map((r, i) => (
          <li key={`${r.title}-${i}`} className="flex items-center gap-3">
            {r.image && <Thumb src={r.image} />}
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-[13.5px]">{r.title}</span>
              <span className={cn("text-[12px] text-muted")}>
                {showStore && <span className="text-fg2">{r.merchant} · </span>}
                {model && r.match !== "exact" && (
                  <span className="text-approval-text">{t.offers.related} · </span>
                )}
                {r.condition === "used" && `${t.offers.used} · `}
              </span>
            </span>
            <span className="shrink-0 text-[14px] font-semibold">{money(r.price, r.currency)}</span>
            {r.url && (
              <a
                href={r.url}
                target="_blank"
                rel="noreferrer noopener"
                aria-label={`${t.offers.openStore}: ${r.title}`}
                className="shrink-0 text-accent-text hover:opacity-80"
              >
                <ExternalLink className="size-3.5" aria-hidden />
              </a>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

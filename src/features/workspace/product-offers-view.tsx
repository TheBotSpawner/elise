"use client";

import { ExternalLink, Package, Search, Sparkles } from "lucide-react";

import type { SurfacePayloads } from "@/core/workspace/registry";
import { useI18n } from "@/lib/i18n/client";

type Offers = SurfacePayloads["product_offers"];

/**
 * Products to buy (ADR-112, ADR-116): Mercado Libre's listings first, a price only where the
 * official API gave it for THAT listing, with when it was checked; otherwise the link and a
 * single line saying the price wasn't verified.
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
                      {x.viaOfficial(when(o.checkedAt))}
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
      {p.options && p.options.length > 0 && (
        <section className="flex flex-col gap-2.5">
          <h3 className="flex items-center gap-2 text-[12px] font-semibold tracking-[0.1em] text-muted uppercase">
            <Sparkles className="size-3.5 text-accent-text" aria-hidden />
            {x.recommended}
          </h3>
          <ol className="flex flex-col gap-2.5">
            {p.options.map((o, i) => (
              <li
                key={o.name}
                className="flex flex-col gap-2 rounded-2xl border border-border bg-surface p-3.5"
              >
                <div className="flex items-start gap-2.5">
                  <span className="grid size-6 shrink-0 place-items-center rounded-md bg-accent-soft text-[12px] font-semibold text-accent-text tabular-nums">
                    {i + 1}
                  </span>
                  <div className="flex min-w-0 flex-col">
                    <span className="text-[15px] leading-snug font-semibold text-fg">{o.name}</span>
                    {o.why && <span className="text-[13px] text-muted">{o.why}</span>}
                  </div>
                </div>
                {o.offers.length > 0 ? (
                  <ul className="flex flex-col gap-1.5">
                    {o.offers.map((offer) => (
                      <li key={offer.url}>
                        <a
                          href={offer.url}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="flex items-center gap-3 rounded-xl px-1.5 py-1 hover:bg-active"
                        >
                          <Thumb src={offer.image} small />
                          <span className="line-clamp-1 min-w-0 flex-1 text-[13px] text-fg2">
                            {offer.title}
                          </span>
                          <span className="shrink-0 text-[15px] font-semibold">
                            {offer.price !== null ? money(offer.price, offer.currency) : x.noPrice}
                          </span>
                        </a>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-[12.5px] text-muted">{x.noListing}</p>
                )}
                <OpenLink href={o.searchUrl} label={x.seeAll} />
              </li>
            ))}
          </ol>
        </section>
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

      {p.notes.map((n) => (
        <p key={n} className="text-[12.5px] text-muted">
          {n}
        </p>
      ))}
      <p className="text-[11.5px] text-faint">{x.disclaimer}</p>
    </div>
  );
}

function Thumb({ src, small = false }: { src: string | null; small?: boolean }) {
  const size = small ? "size-10" : "size-16";
  return src ? (
    // Only images from the source's own image hosts (validated server-side).
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt=""
      loading="lazy"
      className={`${size} shrink-0 rounded-lg bg-white object-contain`}
    />
  ) : (
    <span className={`grid ${size} shrink-0 place-items-center rounded-lg bg-surface-2 text-faint`}>
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
      {/* A close model is shown plainly: the owner asked never to label it "not exact". */}
      {flagged === "accessory" && <span className="text-approval-text">{x.accessory}</span>}
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

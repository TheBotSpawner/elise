"use client";

import { ExternalLink, Search } from "lucide-react";

import type { SurfacePayloads } from "@/core/workspace/registry";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

type Offers = SurfacePayloads["product_offers"];

/**
 * Products to buy (ADR-112): Mercado Libre's offers, each saying how much of it is verified. A
 * price shows only when the official API gave it; a listing found by search says its price is on
 * the listing; the marketplace's own search is a labeled link, never a product.
 */
export function ProductOffersBody({ p }: { p: Offers }) {
  const { t, locale } = useI18n();
  const x = t.offers;
  const m = p.marketplace;
  const money = (n: number, currency: string | null) =>
    new Intl.NumberFormat(locale, {
      style: "currency",
      currency: currency ?? "ARS",
      maximumFractionDigits: Number.isInteger(n) ? 0 : 2,
    }).format(n);
  const when = (iso: string) =>
    new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[12.5px] text-muted">
        <span className="font-medium text-fg2">{x.source}</span>
        {" · "}
        {m.method === "api" ? x.viaApi : m.method === "search" ? x.viaSearch : x.viaLink}
        {p.maxPrice !== null && ` · ${x.upTo(money(p.maxPrice, p.currency))}`}
      </p>
      {m.offers.length > 0 && (
        <ul className="flex flex-col gap-2">
          {m.offers.map((o) => (
            <li
              key={o.url}
              className="flex gap-3 rounded-xl border border-border bg-surface px-3 py-2.5"
            >
              {o.image && (
                // Images only from Mercado Libre's own static host (validated server-side).
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={o.image}
                  alt=""
                  loading="lazy"
                  className="size-16 shrink-0 rounded-lg bg-white object-contain"
                />
              )}
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="line-clamp-2 text-[14px]">{o.title}</span>
                <span
                  className={cn(
                    "text-[15px]",
                    o.price !== null ? "font-mono" : "text-[12.5px] text-muted",
                  )}
                >
                  {o.price !== null ? money(o.price, o.currency) : x.noPrice}
                </span>
                <span className="flex flex-wrap gap-x-2 gap-y-0.5 text-[12px] text-faint">
                  {o.condition && <span>{o.condition === "used" ? x.used : x.new}</span>}
                  {o.match !== "exact" && (
                    <span className="text-approval-text">
                      {o.match === "accessory" ? x.accessory : x.related}
                    </span>
                  )}
                  {o.evidence === "api" && (
                    <span>{o.freeShipping ? x.freeShipping : x.shippingUnknown}</span>
                  )}
                  {o.installments && <span>{o.installments}</span>}
                  {o.seller && <span>{o.seller}</span>}
                  {o.evidence === "api" && <span>{x.checked(when(o.checkedAt))}</span>}
                </span>
                <a
                  href={o.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="flex items-center gap-1 self-start text-[13px] text-accent-text hover:underline"
                >
                  {x.open}
                  <ExternalLink className="size-3.5" aria-hidden />
                </a>
              </div>
            </li>
          ))}
        </ul>
      )}
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

"use client";

import { Check, Loader2, Search } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Select } from "@/components/ui/input";
import { AR_PROVINCES, type LinkedLine, type Region } from "@/core/shopping/model";
import type { SurfacePayloads } from "@/core/workspace/registry";
import { ShoppingBody } from "@/features/workspace/shopping-view";
import { errorText } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";

import {
  compareListAction,
  findProductsAction,
  linkItemAction,
  listLinesAction,
  setShoppingRegionAction,
  unlinkItemAction,
} from "./shopping-actions";

type Payload = SurfacePayloads["shopping"];

/**
 * "Comparar precios" on a list (ADR-111): the same comparison ELISE gives in chat, plus choosing
 * which real product each item is (or correcting it). Nothing on the list itself changes: a link
 * is kept beside the item.
 */
export function ShoppingCompare({
  list,
  onClose,
}: {
  list: { id: string; name: string };
  onClose: () => void;
}) {
  const { t } = useI18n();
  const x = t.shopping;
  const [busy, setBusy] = useState(true);
  const [payload, setPayload] = useState<Payload | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [needsRegion, setNeedsRegion] = useState(false);
  const [region, setRegion] = useState<string>("");
  const [lines, setLines] = useState<LinkedLine[]>([]);
  const [choosing, setChoosing] = useState<LinkedLine | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    setMessage(null);
    const [cmp, ls] = await Promise.all([compareListAction(list.id), listLinesAction(list.id)]);
    setBusy(false);
    if (ls.ok) {
      setLines(ls.value.lines);
      setRegion((r) => r || ls.value.region || "");
    }
    if (!cmp.ok) return setMessage(errorText(t, cmp.error));
    const out = cmp.value.output;
    setNeedsRegion(Boolean(out.needsRegion));
    if (out.available === false) setMessage(x.unavailable);
    else if (out.empty) setMessage(t.shopping.nothingToCompare);
    setPayload(cmp.value.payload);
  }, [list.id, t, x.unavailable]);

  useEffect(() => {
    // Read right after opening (not inside the effect body itself).
    const id = setTimeout(() => void load(), 0);
    return () => clearTimeout(id);
  }, [load]);

  const saveRegion = async (code: string) => {
    setBusy(true);
    const r = await setShoppingRegionAction(code);
    if (!r.ok) {
      setBusy(false);
      return void toast.error(errorText(t, r.error));
    }
    await load();
  };

  return (
    <Dialog open onClose={onClose} title={x.compareTitle(list.name)} size="form" busy={busy}>
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex min-w-48 flex-1 flex-col gap-1.5">
            <Label htmlFor="shopping-region">{x.region}</Label>
            <Select
              id="shopping-region"
              value={region}
              onChange={(e) => setRegion(e.target.value)}
              className="h-10"
            >
              <option value="">{x.chooseRegion}</option>
              {(Object.keys(AR_PROVINCES) as Region[]).map((r) => (
                <option key={r} value={r}>
                  {AR_PROVINCES[r]}
                </option>
              ))}
            </Select>
          </div>
          <Button
            size="sm"
            variant="secondary"
            disabled={!region || busy}
            onClick={() => void saveRegion(region)}
          >
            {needsRegion ? x.choose : x.changeRegion}
          </Button>
        </div>
        {needsRegion && <p className="text-[13px] text-muted">{x.regionHint}</p>}
        {busy && !payload && (
          <p className="flex items-center gap-2 text-[13.5px] text-muted">
            <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden />
            {x.loading}
          </p>
        )}
        {message && <p className="text-[13.5px] text-muted">{message}</p>}
        {payload && payload.basket && <ShoppingBody p={{ ...payload, candidates: [] }} large />}

        {lines.length > 0 && !needsRegion && (
          <section className="flex flex-col gap-2">
            <h3 className="type-label text-faint">{x.lines}</h3>
            <ul className="flex flex-col gap-1.5">
              {lines.map((l) => {
                const product = payload?.basket?.lines.find((b) => b.label === l.label)?.product;
                return (
                  <li
                    key={l.itemId}
                    className="flex flex-wrap items-center gap-2 rounded-xl border border-border px-3 py-2"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[14px]">{l.label}</span>
                      <span className="block truncate text-[12px] text-faint">
                        {l.ean ? (product?.name ?? l.ean) : x.unresolved}
                        {l.ean && l.quantity > 1 ? ` · ${x.quantity(l.quantity)}` : ""}
                      </span>
                    </span>
                    {l.ean && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={async () => {
                          const r = await unlinkItemAction(l.itemId);
                          if (!r.ok) return void toast.error(errorText(t, r.error));
                          await load();
                        }}
                      >
                        {x.unlink}
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant={l.ean ? "ghost" : "secondary"}
                      disabled={busy}
                      onClick={() => setChoosing(l)}
                    >
                      {l.ean ? x.changeRegion : x.choose}
                    </Button>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
        {choosing && (
          <ProductChooser
            line={choosing}
            onCancel={() => setChoosing(null)}
            onChosen={async (ean, quantity) => {
              const r = await linkItemAction(
                list.id,
                { id: choosing.itemId, content: choosing.label },
                ean,
                quantity,
              );
              if (!r.ok) return void toast.error(errorText(t, r.error));
              setChoosing(null);
              await load();
            }}
          />
        )}
      </div>
    </Dialog>
  );
}

/** Real catalog products for an item: the person picks one (and how many). */
function ProductChooser({
  line,
  onCancel,
  onChosen,
}: {
  line: LinkedLine;
  onCancel: () => void;
  onChosen: (ean: string, quantity: number) => Promise<void>;
}) {
  const { t, locale } = useI18n();
  const x = t.shopping;
  const [query, setQuery] = useState(line.label);
  const [options, setOptions] = useState<Payload["candidates"] | null>(null);
  const [quantity, setQuantity] = useState(line.quantity || 1);
  const [busy, setBusy] = useState(false);
  const money = (c: number) =>
    new Intl.NumberFormat(locale, {
      style: "currency",
      currency: "ARS",
      maximumFractionDigits: 0,
    }).format(c / 100);
  const search = async () => {
    setBusy(true);
    const r = await findProductsAction(query);
    setBusy(false);
    if (!r.ok) return void toast.error(errorText(t, r.error));
    const p = r.value.payload;
    // A barcode answers with one product; words with options.
    setOptions(
      p?.candidates.length
        ? p.candidates
        : p?.product
          ? [
              {
                ...p.product,
                forLine: null,
                extraVariant: [],
                fromCents: p.chains[0]?.listCents ?? null,
              },
            ]
          : [],
    );
  };
  return (
    <section className="flex flex-col gap-2.5 rounded-2xl border border-accent-line p-3.5">
      <form
        className="flex items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void search();
        }}
      >
        <div className="flex flex-1 flex-col gap-1.5">
          <Label htmlFor="shopping-search">{x.search}</Label>
          <Input
            id="shopping-search"
            value={query}
            maxLength={120}
            onChange={(e) => setQuery(e.target.value)}
            className="h-10"
          />
          <span className="text-[12px] text-faint">{x.searchHint}</span>
        </div>
        <Button
          type="submit"
          size="sm"
          disabled={busy || query.trim().length < 2}
          aria-label={x.search}
        >
          {busy ? (
            <Loader2 className="motion-safe:animate-spin" aria-hidden />
          ) : (
            <Search aria-hidden />
          )}
        </Button>
      </form>
      {options && !options.length && <p className="text-[13px] text-muted">{x.noMatches}</p>}
      {options && options.length > 0 && (
        <>
          <label className="flex items-center gap-2 text-[13px]">
            {x.quantityLabel}
            <Select
              value={String(quantity)}
              onChange={(e) => setQuantity(Number(e.target.value))}
              className="h-9 w-20"
            >
              {Array.from({ length: 12 }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Select>
          </label>
          <ul className="flex flex-col gap-1.5">
            {options.map((o) => (
              <li key={o.ean}>
                <button
                  type="button"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    await onChosen(o.ean, quantity);
                    setBusy(false);
                  }}
                  className="flex w-full items-center gap-2 rounded-xl border border-border px-3 py-2 text-left hover:border-accent-line hover:bg-accent-soft/40"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block text-[14px]">{o.name}</span>
                    <span className="block text-[12px] text-faint">
                      {[
                        o.brand,
                        o.size,
                        o.fromCents !== null ? x.from(money(o.fromCents)) : null,
                        ...o.extraVariant.map((v) => x.variant(v)),
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </span>
                  <Check className="size-4 shrink-0 text-faint" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      <Button size="sm" variant="ghost" className="self-start" onClick={onCancel}>
        {t.common.cancel}
      </Button>
    </section>
  );
}

import "server-only";

import { z } from "zod";

import { AppError } from "@/core/errors";
import {
  ars,
  canonicalEan,
  evaluateAlert,
  MAX_ALERTS,
  regionSchema,
  AR_PROVINCES,
  type AlertView,
  type ChainPrice,
  type Region,
  type ShoppingCapability,
  type ShoppingData,
} from "@/core/shopping/model";
import { logger } from "@/infrastructure/observability/logger";
import { mercadoLibreApi } from "@/infrastructure/shopping/mercadolibre";
import { supabaseShoppingData } from "@/infrastructure/shopping/store";
import { createAdminClient } from "@/infrastructure/supabase/admin";
import type { Json, ShoppingPriceAlertRow } from "@/infrastructure/supabase/database.types";

import type { AuthContext } from "./auth-context";

/**
 * Shopping prices for one person (ADR-111): the public data shared by everyone, and what is
 * theirs under RLS — the province they shop in, list items linked to products, price alerts.
 * Their lists never leave ELISE: prices are looked up by barcode in ELISE's own copy.
 */

const PREF_KEY = "shopping";

const alertOf = (r: ShoppingPriceAlertRow): AlertView => ({
  id: r.id,
  ean: r.ean,
  productName: r.product_name,
  region: r.region as Region,
  thresholdCents: r.threshold_cents,
  chains: r.chains,
  status: r.status,
  state: r.state,
  lastCheck: r.last_check,
  lastCheckedAt: r.last_checked_at,
  lastBestCents: r.last_best_cents,
  lastBestChain: r.last_best_chain,
  lastQuoteDate: r.last_quote_date,
});

const db = (auth: AuthContext) => auth.db;

export function shoppingCapability(
  auth: AuthContext,
  data: ShoppingData = supabaseShoppingData(),
): ShoppingCapability {
  /** One preference row for shopping (province, marketplace): each save merges, never wipes. */
  const prefs = async (): Promise<Record<string, unknown>> => {
    const { data: pref } = await db(auth)
      .from("user_preferences")
      .select("value_json")
      .eq("workspace_id", auth.workspaceId)
      .eq("user_id", auth.userId)
      .eq("key", PREF_KEY)
      .maybeSingle();
    const v = pref?.value_json;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  };
  const savePrefs = async (patch: Record<string, unknown>) => {
    const next = { ...(await prefs()), ...patch };
    for (const k of Object.keys(next)) if (next[k] === null) delete next[k];
    const { error } = await db(auth)
      .from("user_preferences")
      .upsert(
        {
          workspace_id: auth.workspaceId,
          user_id: auth.userId,
          key: PREF_KEY,
          value_json: next as Json,
          source: "user",
        },
        { onConflict: "workspace_id,user_id,key" },
      );
    if (error)
      throw new AppError("INTERNAL_ERROR", "Could not save the preference", { cause: error });
  };
  return {
    data,
    async region() {
      const r = regionSchema.safeParse((await prefs()).region);
      return r.success ? r.data : null;
    },
    async saveRegion(region) {
      await savePrefs({ region: regionSchema.parse(region) });
    },
    marketplace: mercadoLibreApi(),
    async marketplaceMode() {
      const m = (await prefs()).marketplace;
      return m === "prefer" || m === "only" || m === "avoid" ? m : null;
    },
    async saveMarketplaceMode(mode) {
      await savePrefs({ marketplace: mode });
    },
    async listLines(listId) {
      const { data: items, error } = await db(auth)
        .from("list_items")
        .select("id, content, position")
        .eq("workspace_id", auth.workspaceId)
        .eq("list_id", z.uuid().parse(listId))
        .eq("checked", false)
        .is("archived_at", null)
        .order("position")
        .limit(100);
      if (error) throw new AppError("INTERNAL_ERROR", "Could not read the list", { cause: error });
      const ids = (items ?? []).map((i) => i.id);
      const { data: links } = ids.length
        ? await db(auth)
            .from("list_item_products")
            .select("list_item_id, ean, quantity, match_method")
            .eq("workspace_id", auth.workspaceId)
            .in("list_item_id", ids)
        : { data: [] };
      const byItem = new Map((links ?? []).map((l) => [l.list_item_id, l]));
      return (items ?? []).map((i) => {
        const l = byItem.get(i.id);
        return {
          itemId: i.id,
          label: i.content,
          ean: l?.ean ?? null,
          quantity: l?.quantity ?? 1,
          method: l?.match_method ?? null,
        };
      });
    },
    async link(itemId, ean, quantity, method) {
      const code = canonicalEan(ean);
      if (!code)
        throw new AppError("VALIDATION_ERROR", "That isn't a valid barcode", {
          recovery: "review",
        });
      const { data: item } = await db(auth)
        .from("list_items")
        .select("id")
        .eq("id", z.uuid().parse(itemId))
        .eq("workspace_id", auth.workspaceId)
        .maybeSingle();
      if (!item) throw new AppError("NOT_FOUND", "That list item isn't in your lists");
      const { error } = await db(auth)
        .from("list_item_products")
        .upsert(
          {
            list_item_id: item.id,
            workspace_id: auth.workspaceId,
            ean: code,
            quantity: Math.max(1, Math.min(99, Math.round(quantity))),
            match_method: method,
            created_by_user_id: auth.userId,
          },
          { onConflict: "list_item_id" },
        );
      if (error)
        throw new AppError("INTERNAL_ERROR", "Could not link the product", { cause: error });
    },
    async unlink(itemId) {
      const { error } = await db(auth)
        .from("list_item_products")
        .delete()
        .eq("list_item_id", z.uuid().parse(itemId))
        .eq("workspace_id", auth.workspaceId);
      if (error) throw new AppError("INTERNAL_ERROR", "Could not unlink it", { cause: error });
    },
    alerts: {
      async list() {
        const { data: rows, error } = await db(auth)
          .from("shopping_price_alerts")
          .select("*")
          .eq("workspace_id", auth.workspaceId)
          .eq("user_id", auth.userId)
          .order("created_at", { ascending: false })
          .limit(MAX_ALERTS);
        if (error) throw new AppError("INTERNAL_ERROR", "Could not read alerts", { cause: error });
        return (rows ?? []).map(alertOf);
      },
      async create(a) {
        const ean = canonicalEan(a.ean);
        if (!ean) throw new AppError("VALIDATION_ERROR", "That isn't a valid barcode");
        if (!Number.isInteger(a.thresholdCents) || a.thresholdCents <= 0 || a.thresholdCents > 5e9)
          throw new AppError("VALIDATION_ERROR", "The price must be a positive amount");
        const { count } = await db(auth)
          .from("shopping_price_alerts")
          .select("id", { count: "exact", head: true })
          .eq("workspace_id", auth.workspaceId)
          .eq("user_id", auth.userId)
          .eq("status", "active");
        if ((count ?? 0) >= MAX_ALERTS)
          throw new AppError("VALIDATION_ERROR", `You can have up to ${MAX_ALERTS} price alerts`, {
            recovery: "review",
          });
        const { data: row, error } = await db(auth)
          .from("shopping_price_alerts")
          .insert({
            workspace_id: auth.workspaceId,
            user_id: auth.userId,
            ean,
            product_name: a.productName.slice(0, 200),
            region: regionSchema.parse(a.region),
            threshold_cents: a.thresholdCents,
            chains: a.chains?.length ? a.chains.slice(0, 20) : null,
          })
          .select("*")
          .single();
        if (error || !row)
          throw new AppError("INTERNAL_ERROR", "Could not save the alert", { cause: error });
        return alertOf(row);
      },
      async remove(id) {
        const { error } = await db(auth)
          .from("shopping_price_alerts")
          .delete()
          .eq("id", z.uuid().parse(id))
          .eq("workspace_id", auth.workspaceId)
          .eq("user_id", auth.userId);
        if (error)
          throw new AppError("INTERNAL_ERROR", "Could not delete the alert", { cause: error });
      },
    },
  };
}

/**
 * After fresh data (the ingestion): every active alert checked once against today's prices.
 * Fires once per crossing (a notification unique per alert and crossing time), re-arms when the
 * price is back above; old or missing data never fires.
 */
export async function checkPriceAlerts(
  pricesFor: (ean: string, region: Region) => ChainPrice[],
  now: Date,
): Promise<{ checked: number; fired: number; stale: number }> {
  const admin = createAdminClient();
  const { data: alerts } = await admin
    .from("shopping_price_alerts")
    .select("*")
    .eq("status", "active")
    .limit(10_000);
  let fired = 0;
  let stale = 0;
  for (const a of alerts ?? []) {
    const region = regionSchema.safeParse(a.region);
    if (!region.success) continue;
    const r = evaluateAlert(
      {
        ean: a.ean,
        region: region.data,
        thresholdCents: a.threshold_cents,
        chains: a.chains,
        state: a.state,
      },
      pricesFor(a.ean, region.data),
      now,
    );
    if (r.outcome === "stale" || r.outcome === "no_data") stale++;
    const at = now.toISOString();
    const patch = {
      last_check: r.outcome,
      last_checked_at: at,
      ...(r.best
        ? {
            last_best_cents: r.best.listCents,
            last_best_chain: r.best.chain.name.slice(0, 120),
            last_quote_date: r.best.quoteDate,
          }
        : {}),
      ...(r.outcome === "fire" ? { state: "triggered" as const, triggered_at: at } : {}),
      ...(r.outcome === "rearm" ? { state: "armed" as const } : {}),
    };
    // Compare-and-set on the state: two checks at once never notify twice.
    const { data: updated } = await admin
      .from("shopping_price_alerts")
      .update(patch)
      .eq("id", a.id)
      .eq("state", a.state)
      .select("id");
    if (r.outcome !== "fire" || !updated?.length || !r.best) continue;
    const { error } = await admin.from("notifications").insert({
      workspace_id: a.workspace_id,
      user_id: a.user_id,
      notification_type: "price_alert",
      title: `${a.product_name.slice(0, 80)}: ${ars(r.best.listCents)} en ${r.best.chain.name}`,
      content: `Precio de referencia en ${AR_PROVINCES[region.data]} (SEPA, ${r.best.quoteDate}). Tu umbral: ${ars(a.threshold_cents)}.`,
      source_type: "shopping_price_alert",
      source_id: `${a.id}:${at}`,
      action_url: "/",
      metadata: { alertId: a.id, browser: false },
    });
    if (!error || error.code === "23505") fired++;
    else logger.warn("shopping_alert_notify_failed", { alert_id: a.id, code: error.code });
  }
  return { checked: alerts?.length ?? 0, fired, stale };
}

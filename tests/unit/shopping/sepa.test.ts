import { strToU8, zipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";

import { aggregateSepaDay, cents } from "@/infrastructure/shopping/sepa";
import {
  buildSnapshots,
  decodeSnapshot,
  encodeSnapshot,
  pricesOf,
} from "@/infrastructure/shopping/snapshot";

vi.mock("server-only", () => ({}));
const { historyRows, newestDailyFile } = await import("@/application/shopping-ingest");

/**
 * ADR-111: one SEPA day, simulated with the official layout — a ZIP of company ZIPs, each with
 * comercio.csv, sucursales.csv and productos.csv (pipe-separated), files in any order.
 */

const COMERCIO_H =
  "id_comercio|id_bandera|comercio_cuit|comercio_razon_social|comercio_bandera_nombre|comercio_bandera_url|comercio_ultima_actualizacion|comercio_version_sepa";
const SUC_H =
  "id_comercio|id_bandera|id_sucursal|sucursales_nombre|sucursales_tipo|sucursales_calle|sucursales_numero|sucursales_latitud|sucursales_longitud|sucursales_observaciones|sucursales_barrio|sucursales_codigo_postal|sucursales_localidad|sucursales_provincia";
const PROD_H =
  "id_comercio|id_bandera|id_sucursal|id_producto|productos_ean|productos_descripcion|productos_cantidad_presentacion|productos_unidad_medida_presentacion|productos_marca|productos_precio_lista|productos_precio_referencia|productos_cantidad_referencia|productos_unidad_medida_referencia|productos_precio_unitario_promo1|productos_leyenda_promo1|productos_precio_unitario_promo2|productos_leyenda_promo2";

const MILK = "7790742656018";
const company = (
  id: number,
  name: string,
  updated: string,
  sucursales: string[],
  productos: string[],
) =>
  zipSync({
    // productos first: the reader must not depend on the order.
    "productos.csv": strToU8([PROD_H, ...productos, "", "Última actualización: x"].join("\r\n")),
    "comercio.csv": strToU8(
      [COMERCIO_H, `${id}|1|30|${name} S.A.|${name}|http://x|${updated}|1.0`].join("\n"),
    ),
    "sucursales.csv": strToU8([SUC_H, ...sucursales].join("\n")),
  });

function day() {
  const fresh = company(
    15,
    "DIA",
    "2026-10-22T04:05:34-03:00",
    [
      "15|1|1|S1|Super|A|1|-34|-58|||1000|CABA|AR-C",
      "15|1|2|S2|Super|A|1|-34|-58|||1000|CABA|AR-C",
      "15|1|3|S3|Super|A|1|-31|-64|||5000|CBA|AR-X",
    ],
    [
      // Three branches in two provinces; one has a general promo, one a conditional one.
      `15|1|1|${MILK}|1|LECHE ENTERA 1 L|1|lt|SERENISIMA|1200.50|1200.50|1|lt|1000|2x1|||`,
      `15|1|2|${MILK}|1|LECHE ENTERA 1 L|1|lt|SERENISIMA|1300|1300|1|lt|1100|2x1||30% Banco X`,
      `15|1|3|${MILK}|1|LECHE ENTERA 1 L|1|lt|SERENISIMA|1400|1400|1|lt||||`,
      // Internal code (not a barcode), a wrong check digit, a zero price: never kept.
      "15|1|1|12345|0|PAN FRANCES X KG|1|kg||3000|3000|1|kg||||",
      "15|1|1|7790742656019|1|LECHE MAL CODIGO 1 L|1|lt||999|999|1|lt||||",
      `15|1|2|${MILK}|1|LECHE ENTERA 1 L|1|lt|SERENISIMA|0|0|1|lt||||`,
    ],
  );
  const stale = company(
    11,
    "CHANGO",
    "2021-04-03T12:53:43-03:00",
    ["11|1|1|S|Hiper|A|1|-34|-58|||1000|CABA|AR-C"],
    [`11|1|1|${MILK}|1|LECHE ENTERA 1 L|1|lt|SERENISIMA|1|1|1|lt||||`],
  );
  return zipSync({
    "2026-10-22/": {},
    "2026-10-22/sepa_dia.zip": fresh,
    "2026-10-22/sepa_chango.zip": stale,
    "2026-10-22/empty.zip": new Uint8Array(0),
  });
}

async function* stream(bytes: Uint8Array, size = 1000) {
  for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, i + size);
}

describe("SEPA day → ELISE's aggregates", () => {
  it("median per chain and province; promos apart; stale companies and bad rows dropped", async () => {
    const d = await aggregateSepaDay(stream(day()), new Date("2026-10-22T12:00:00-03:00"));
    expect(d.stats.skippedStale).toEqual([
      { company: "CHANGO S.A.", lastUpdate: "2021-04-03T12:53:43-03:00" },
    ]);
    expect([...d.products.keys()]).toEqual([MILK]);
    expect(d.products.get(MILK)!.size).toEqual({ amount: 1000, unit: "ml" });
    const caba = d.prices.find((p) => p.region === "AR-C")!;
    expect(caba).toMatchObject({
      chain: { id: "15-1", name: "DIA" },
      listCents: 125_025, // median of 1200.50 and 1300
      minCents: 120_050,
      branches: 2,
      promoCents: 105_000,
      promoLabel: "2x1",
      conditionalLabel: "30% Banco X",
      quoteDate: "2026-10-22",
    });
    expect(d.prices.find((p) => p.region === "AR-X")).toMatchObject({
      listCents: 140_000,
      branches: 1,
      promoCents: null,
    });
    expect(d.stats.rejected).toBe(2);
  });

  it("each province's snapshot round-trips, and a tampered file is refused", async () => {
    const d = await aggregateSepaDay(stream(day()), new Date("2026-10-22T12:00:00-03:00"));
    const snaps = buildSnapshots(d, "2026-10-22", "sepa_jueves.zip");
    const back = decodeSnapshot(encodeSnapshot(snaps.get("AR-C")!));
    expect(pricesOf(back, MILK)).toEqual([
      expect.objectContaining({ listCents: 125_025, region: "AR-C" }),
    ]);
    expect(pricesOf(back, "7790000000000")).toEqual([]);
    back.prices[MILK] = [["x"]];
    expect(pricesOf(back, MILK)).toEqual([]);
    expect(() => decodeSnapshot(encodeSnapshot({ ...back, region: "AR-ZZ" as never }))).toThrow();
  });

  it("prices: decimals, commas, nonsense", () => {
    expect(cents("1234.5")).toBe(123_450);
    expect(cents("1234,5")).toBe(123_450);
    expect(cents("0")).toBeNull();
    expect(cents("-3")).toBeNull();
    expect(cents("abc")).toBeNull();
  });
});

describe("ingestion guards", () => {
  const ckan = (url: string, description = "Precios SEPA Minoristas jueves, 2026-10-22") => ({
    success: true,
    result: { resources: [{ url, name: "Jueves", description }] },
  });

  it("only the official host, over https, and the newest day", () => {
    const ok = "https://datos.produccion.gob.ar/dataset/x/resource/y/download/sepa_jueves.zip";
    expect(newestDailyFile(ckan(ok))).toEqual({
      url: ok,
      date: "2026-10-22",
      name: "sepa_jueves.zip",
    });
    expect(newestDailyFile(ckan("https://evil.example/dataset/sepa.zip"))).toBeNull();
    expect(newestDailyFile(ckan("http://datos.produccion.gob.ar/dataset/sepa.zip"))).toBeNull();
    expect(newestDailyFile(ckan("https://datos.produccion.gob.ar/other/sepa.zip"))).toBeNull();
    expect(newestDailyFile({ success: false })).toBeNull();
  });

  it("history is delta-only: an unchanged price adds nothing", () => {
    const p = {
      ean: MILK,
      chain: { id: "15-1", name: "DIA" },
      region: "AR-C" as const,
      listCents: 125_025,
      minCents: 1,
      branches: 2,
      promoCents: null,
      promoLabel: null,
      conditionalLabel: null,
      quoteDate: "2026-10-22",
    };
    expect(historyRows([p], new Map([[`${MILK}|AR-C|15-1`, 125_025]]))).toEqual([]);
    expect(historyRows([p], new Map([[`${MILK}|AR-C|15-1`, 120_000]]))).toEqual([
      {
        ean: MILK,
        region: "AR-C",
        chain_id: "15-1",
        chain_name: "DIA",
        observed_on: "2026-10-22",
        list_cents: 125_025,
      },
    ]);
  });
});

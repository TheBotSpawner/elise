/**
 * ADR-116: connects ELISE's own Mercado Libre application account (OAuth authorization_code +
 * PKCE), and checks what the official API gives. Runs locally against the database in .env.local;
 * secrets stay on this machine and are never printed.
 *
 *   npx --yes tsx@4.19.2 --conditions=react-server --env-file=.env.local --tsconfig tsconfig.json scripts/mercadolibre-connect.ts connect
 *   … scripts/mercadolibre-connect.ts status
 *   … scripts/mercadolibre-connect.ts probe MLA1528226212 [words to search]
 *   … scripts/mercadolibre-connect.ts disconnect
 *
 *   … scripts/mercadolibre-connect.ts finish "<the address the browser returned to>"
 *
 * connect: prints (and opens) Mercado Libre's consent page and keeps the state and PKCE verifier
 * encrypted in the OS temp folder for 10 minutes. After you accept, the browser goes to the
 * registered redirect URI (a "not found" page there is fine): give that whole address to finish.
 */
import { exec } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { decrypt, encrypt } from "../src/infrastructure/crypto/encryption";
import {
  call,
  completeAuthorization,
  connectionStatus,
  disconnect,
  startAuthorization,
} from "../src/infrastructure/shopping/mercadolibre";

const fieldsOf = (body: unknown) =>
  body && typeof body === "object" ? Object.keys(body as object).slice(0, 30) : [];

/** The pending authorization (state + PKCE verifier), encrypted, single use, 10 minutes. */
const PENDING = join(tmpdir(), "elise-mercadolibre-oauth.json");
const PENDING_CONTEXT = "mercadolibre_oauth_pending";

function connect() {
  const a = startAuthorization();
  writeFileSync(
    PENDING,
    encrypt(JSON.stringify({ ...a, until: Date.now() + 10 * 60_000 }), PENDING_CONTEXT),
    { mode: 0o600 },
  );
  console.log("\nAbrí esta dirección y aceptá con tu cuenta de Mercado Libre (vale 10 minutos):\n");
  console.log(a.url);
  if (process.platform === "win32") exec(`start "" "${a.url.replace(/&/g, "^&")}"`);
  console.log(
    "\nDespués copiá la dirección completa a la que volvió el navegador (aunque diga 'no encontrado') y corré:\n  … scripts/mercadolibre-connect.ts finish \"<esa dirección>\"",
  );
}

async function finish(returned: string) {
  if (!existsSync(PENDING)) throw new Error("No hay una autorización pendiente: corré connect.");
  const pending = JSON.parse(decrypt(readFileSync(PENDING, "utf8"), PENDING_CONTEXT)) as {
    state: string;
    verifier: string;
    until: number;
  };
  rmSync(PENDING); // single use, whatever happens next
  if (Date.now() > pending.until)
    throw new Error("La autorización venció: corré connect otra vez.");
  const who = await completeAuthorization(returned, pending);
  console.log(
    `\nConectado: cuenta ${who.nickname ?? "?"} (id ${who.userId ?? "?"}). Token guardado cifrado en app_credentials.`,
  );
}

async function probe(id: string, words: string | undefined) {
  const report = async (label: string, path: string) => {
    const r = await call(path).catch((e: Error) => ({
      status: -1,
      ms: 0,
      body: { error: e.message },
    }));
    console.log(`\n${label}\n  GET ${path.replace(/\?.*$/, "?…")} → HTTP ${r.status} · ${r.ms} ms`);
    console.log(`  campos: ${fieldsOf(r.body).join(", ") || "—"}`);
    return r;
  };
  const it = await report("Publicación", `/items/${encodeURIComponent(id)}`);
  if (it.status === 200) {
    const b = it.body as {
      title?: string;
      permalink?: string;
      status?: string;
      pictures?: { secure_url?: string }[];
      price?: number | null;
      currency_id?: string;
      seller_id?: number;
    };
    console.log(`  título: ${b.title ?? "—"}`);
    console.log(`  estado: ${b.status ?? "—"} · vendedor: ${b.seller_id ?? "—"}`);
    console.log(`  enlace: ${b.permalink ?? "—"}`);
    console.log(
      `  fotos: ${b.pictures?.length ?? 0}${b.pictures?.[0]?.secure_url ? ` (primera: ${b.pictures[0].secure_url})` : ""}`,
    );
    console.log(`  price (campo de /items, en retiro): ${b.price ?? "—"} ${b.currency_id ?? ""}`);
  }
  const sale = await report(
    "Precio de venta (API de precios)",
    `/items/${encodeURIComponent(id)}/sale_price?context=channel_marketplace`,
  );
  if (sale.status === 200) {
    const s = sale.body as {
      amount?: number;
      regular_amount?: number | null;
      currency_id?: string;
    };
    console.log(
      `  amount: ${s.amount ?? "—"} ${s.currency_id ?? ""} · regular_amount: ${s.regular_amount ?? "—"}`,
    );
  }
  await report("Precios (lista)", `/items/${encodeURIComponent(id)}/prices`);
  if (words)
    await report(
      "Búsqueda de catálogo",
      `/products/search?${new URLSearchParams({ status: "active", site_id: "MLA", q: words })}`,
    );
}

async function main() {
  const [cmd, a, ...rest] = process.argv.slice(2);
  if (cmd === "connect") connect();
  else if (cmd === "finish" && a) await finish(a);
  else if (cmd === "status") console.log(await connectionStatus());
  else if (cmd === "disconnect") {
    await disconnect();
    console.log(
      "Credenciales borradas en ELISE. Para revocar del todo: Mercado Libre → Mi cuenta → Seguridad → Aplicaciones.",
    );
  } else if (cmd === "probe" && a) await probe(a, rest.join(" ") || undefined);
  else
    console.log(
      "Uso: connect | finish <dirección> | status | probe <MLA…> [palabras] | disconnect",
    );
}

main().catch((e: Error) => {
  // Messages only: never a token.
  console.error(`Error: ${e.message}`);
  process.exitCode = 1;
});

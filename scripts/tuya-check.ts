/**
 * ADR-118: checks ELISE's Tuya project against the real Tuya cloud, from this machine. Reads
 * .env.local (TUYA_*); the client secret and the tokens are never printed. Nothing is sent to a
 * device without `--yes`.
 *
 *   npx --yes tsx@4.19.2 --conditions=react-server --env-file=.env.local --tsconfig tsconfig.json scripts/tuya-check.ts status
 *   … scripts/tuya-check.ts devices      the linked Smart Life account's devices (TUYA_DEV_UID)
 *   … scripts/tuya-check.ts remotes      each infrared hub's remotes, keys and what ELISE makes of them
 *   … scripts/tuya-check.ts send <infrared_id> <remote_id> <elise-key | power-on | power-off> [--yes]
 */
import { isTuyaIrHub, isTuyaRegion, kindOf, remoteCapability } from "../src/core/home/tuya";
import {
  projectAuth,
  tuyaConfig,
  tuyaHost,
  tuyaRemoteKeys,
  tuyaRemotes,
  tuyaSendAc,
  tuyaSendKey,
  tuyaUserDevices,
} from "../src/infrastructure/home/tuya";

// The project's own token in the data center of the account linked in Tuya's console (local
// checks only: the app always uses each person's own OAuth token).
const region = isTuyaRegion(process.env.TUYA_REGION) ? process.env.TUYA_REGION : "us";
const auth = projectAuth(region);
const LOCAL = "00000000-0000-4000-8000-000000000000";

const uid = () => {
  const u = process.env.TUYA_DEV_UID;
  if (!u) throw new Error("Falta TUYA_DEV_UID en .env.local (el UID de “Link App Account”).");
  return u;
};

function status() {
  const c = tuyaConfig();
  console.log({
    TUYA_ENABLED: process.env.TUYA_ENABLED ?? "(vacío)",
    TUYA_CLIENT_ID: process.env.TUYA_CLIENT_ID ? "presente" : "falta",
    TUYA_CLIENT_SECRET: process.env.TUYA_CLIENT_SECRET ? "presente" : "falta",
    TUYA_REGION: region,
    host: c ? tuyaHost(region) : "(sin configurar)",
    TUYA_OAUTH_URL: Object.keys(process.env).filter(
      (k) => k.startsWith("TUYA_OAUTH_URL_") && process.env[k],
    ),
    TUYA_DEV_UID: process.env.TUYA_DEV_UID ? "presente" : "falta",
  });
  if (!c) console.log("\nTUYA_ENABLED tiene que ser true y el client id/secret estar cargados.");
}

async function devices() {
  const list = await tuyaUserDevices(auth, uid());
  console.log(`\n${list.length} dispositivos en la cuenta vinculada:\n`);
  for (const d of list)
    console.log(
      `${isTuyaIrHub(d.category) ? "[HUB IR] " : "         "}${d.name} · ${d.category} · ${d.online ? "online" : "offline"}${d.sub ? " · sub" : ""} · ${d.id}`,
    );
}

async function remotes() {
  const hubs = (await tuyaUserDevices(auth, uid())).filter((d) => isTuyaIrHub(d.category));
  if (!hubs.length) console.log("Ningún hub infrarrojo en la cuenta vinculada.");
  for (const h of hubs) {
    console.log(`\n== ${h.name} (${h.online ? "online" : "offline"}) · ${h.id}`);
    for (const r of await tuyaRemotes(auth, h.id)) {
      const keys = await tuyaRemoteKeys(auth, h.id, r.remote_id);
      const cap = remoteCapability(LOCAL, h.id, r, keys);
      console.log(
        `  - ${r.remote_name} · categoría ${r.category_id} (${kindOf(r.category_id)}) · ${r.brand_name ?? "?"} · ${r.remote_id}`,
      );
      console.log(
        `    teclas Tuya (${keys.key_list.length}): ${keys.key_list
          .slice(0, 25)
          .map((k) => k.key)
          .join(", ")}`,
      );
      if (cap?.ac)
        for (const m of cap.ac.modes)
          console.log(
            `    aire ${m.mode}: ${m.temps.join("/")} °C · ventilador ${m.fans.join("/")}`,
          );
      console.log(
        `    ELISE: ${cap ? cap.keys.map((k) => `${k.key}←${k.tuya}`).join(", ") || "(solo clima)" : "nada utilizable"}`,
      );
    }
  }
}

async function send(infraredId: string, remoteId: string, what: string, yes: boolean) {
  const remote = (await tuyaRemotes(auth, infraredId)).find((r) => r.remote_id === remoteId);
  if (!remote) throw new Error("Ese control no está en ese hub.");
  const cap = remoteCapability(
    LOCAL,
    infraredId,
    remote,
    await tuyaRemoteKeys(auth, infraredId, remoteId),
  );
  if (!cap) throw new Error("Tuya no lista teclas para ese control.");
  const target = {
    infraredId,
    remoteId,
    categoryId: cap.categoryId,
    ...(cap.remoteIndex !== undefined ? { remoteIndex: cap.remoteIndex } : {}),
  };
  const ac = what === "power-on" || what === "power-off";
  const key = ac ? null : cap.keys.find((k) => k.key === what || k.tuya === what);
  if (!ac && !key)
    throw new Error(`Tecla desconocida. Teclas: ${cap.keys.map((k) => k.key).join(", ")}`);
  const plan = ac ? `aire: power ${what === "power-on" ? 1 : 0}` : `tecla ${key!.tuya}`;
  if (!yes) {
    console.log(
      `Enviaría ${plan} a “${remote.remote_name}”. Agregá --yes para enviarlo de verdad.`,
    );
    return;
  }
  if (ac) await tuyaSendAc(auth, { ...target, power: what === "power-on" });
  else
    await tuyaSendKey(auth, {
      ...target,
      key: key!.tuya,
      ...(key!.keyId !== undefined ? { keyId: key!.keyId } : {}),
    });
  console.log(`Tuya aceptó ${plan}. Mirá si el equipo reaccionó (infrarrojo no confirma).`);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "status") return status();
  if (cmd === "devices") return devices();
  if (cmd === "remotes") return remotes();
  if (cmd === "send" && rest.length >= 3)
    return send(rest[0]!, rest[1]!, rest[2]!, rest.includes("--yes"));
  console.log("Uso: status | devices | remotes | send <infrared_id> <remote_id> <tecla> [--yes]");
}

main().catch((e: unknown) => {
  const details = (e as { details?: unknown }).details;
  console.error("Error:", e instanceof Error ? e.message : e, details ?? "");
  process.exitCode = 1;
});

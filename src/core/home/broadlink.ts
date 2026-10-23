/**
 * Finding Broadlink controllers on the home network (ADR-117). The home engine only discovers
 * them from DHCP traffic (its integration declares nothing else), which an engine running inside
 * WSL2 never sees. Desktop's runtime runs on the computer itself, on the real network, so it
 * sends Broadlink's own local "hello" (the same broadcast the manufacturer's app and the
 * python-broadlink library use) and reads the replies. Only devices that answer are listed.
 *
 * Wire format, as python-broadlink documents it (protocol `hello`): a 0x30-byte packet with the
 * time, the sender's IPv4 and port and a checksum, sent to UDP port 80; each device replies with
 * its type (0x34), MAC (0x3a, reversed), name (0x40…) and a lock flag (0x7f).
 */

export const BROADLINK_PORT = 80;

export interface BroadlinkFound {
  host: string;
  /** "a043b0123456" (lowercase hex): the engine's unique id for the device. */
  mac: string;
  devtype: number;
  model: string;
  name: string;
  /** Locked in the BroadLink app: it must be unlocked there before anything can use it. */
  locked: boolean;
}

/** Known infrared controllers by device type (from python-broadlink's device table). */
const MODELS: Record<number, string> = {
  0x2712: "RM pro",
  0x272a: "RM pro",
  0x2737: "RM mini 3",
  0x273d: "RM pro",
  0x278f: "RM mini",
  0x2797: "RM pro+",
  0x27a9: "RM pro+",
  0x27c2: "RM mini 3",
  0x27c3: "RM pro+",
  0x27cc: "RM mini 3",
  0x27cd: "RM mini 3",
  0x27d0: "RM mini 3",
  0x27d1: "RM mini 3",
  0x27d3: "RM mini 3",
  0x27dc: "RM mini 3",
  0x27de: "RM mini 3",
  0x5f36: "RM mini 3",
  0x6507: "RM mini 3",
  0x6508: "RM mini 3",
  0x51da: "RM4 mini",
  0x5209: "RM4 TV mate",
  0x520c: "RM4 mini",
  0x520d: "RM4C mini",
  0x5211: "RM4C mate",
  0x5212: "RM4 TV mate",
  0x5216: "RM4 mini",
  0x521c: "RM4 mini",
  0x6070: "RM4C mini",
  0x610e: "RM4 mini",
  0x610f: "RM4C mini",
  0x62bc: "RM4 mini",
  0x62be: "RM4C mini",
  0x6364: "RM4S",
  0x648d: "RM4 mini",
  0x6539: "RM4C mini",
  0x653a: "RM4 mini",
  0x5213: "RM4 pro",
  0x5218: "RM4C pro",
  0x6026: "RM4 pro",
  0x6184: "RM4C pro",
  0x61a2: "RM4 pro",
  0x649b: "RM4 pro",
  0x653c: "RM4 pro",
};

export const isInfrared = (devtype: number) => devtype in MODELS;

/** The hello packet for a sender at `ip:port`, stamped with `now` in the computer's offset. */
export function helloPacket(ip: string, port: number, now: Date): Uint8Array {
  const p = new Uint8Array(0x30);
  const view = new DataView(p.buffer);
  const offsetHours = Math.trunc(-now.getTimezoneOffset() / 60);
  view.setInt32(0x08, offsetHours, true);
  view.setUint16(0x0c, now.getFullYear(), true);
  p[0x0e] = now.getMinutes();
  p[0x0f] = now.getHours();
  p[0x10] = now.getFullYear() % 100;
  p[0x11] = now.getDay() === 0 ? 7 : now.getDay(); // ISO weekday
  p[0x12] = now.getDate();
  p[0x13] = now.getMonth() + 1;
  const octets = ip.split(".").map(Number);
  // The address goes in reversed byte order.
  for (let i = 0; i < 4; i++) p[0x18 + i] = octets[3 - i]! & 0xff;
  view.setUint16(0x1c, port, true);
  p[0x26] = 6;
  let sum = 0xbeaf;
  for (const b of p) sum += b;
  view.setUint16(0x20, sum & 0xffff, true);
  return p;
}

/** One reply → the device, or null when it isn't a Broadlink hello reply. */
export function parseHelloReply(data: Uint8Array, host: string): BroadlinkFound | null {
  if (data.length < 0x40) return null;
  const devtype = data[0x34]! | (data[0x35]! << 8);
  const mac = [...data.slice(0x3a, 0x40)]
    .reverse()
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  if (/^0+$/.test(mac)) return null;
  const nameBytes = data.slice(0x40, Math.min(data.length, 0x40 + 0x3f));
  const end = nameBytes.indexOf(0);
  const name = new TextDecoder()
    .decode(end >= 0 ? nameBytes.slice(0, end) : nameBytes)
    .replace(/[^\p{L}\p{N} ._-]/gu, "")
    .trim()
    .slice(0, 60);
  return {
    host,
    mac,
    devtype,
    model: MODELS[devtype] ?? "Broadlink",
    name,
    locked: data.length > 0x7f ? data[0x7f] !== 0 : false,
  };
}

/** The flow id ELISE shows for a found Broadlink (it isn't the engine's: no setup started yet). */
export const broadlinkFlowId = (mac: string) => `broadlink_${mac}`;
export const BROADLINK_FLOW = /^broadlink_([0-9a-f]{12})$/;

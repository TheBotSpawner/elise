import { createSocket } from "node:dgram";
import { networkInterfaces } from "node:os";

import {
  BROADLINK_PORT,
  helloPacket,
  parseHelloReply,
  type BroadlinkFound,
} from "../src/core/home/broadlink";

/**
 * Broadlink's local hello (ADR-117), from this computer: one broadcast per real network
 * interface (Wi-Fi, Ethernet), never virtual ones (WSL, Hyper-V, VPNs), and only on private
 * networks. Replies for `waitMs`, then done: no repeated sweeps, no unicast scanning of the
 * subnet, nothing sent off the local network.
 */

const VIRTUAL =
  /vethernet|wsl|hyper-v|virtualbox|vmware|vbox|docker|loopback|tailscale|zerotier|vpn|tap|tun/i;

const isPrivate = (ip: string) => {
  const [a, b] = ip.split(".").map(Number) as [number, number];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
};

/** The interface's directed broadcast address ("192.168.1.255" for 192.168.1.x/24). */
export function broadcastOf(ip: string, netmask: string): string {
  const a = ip.split(".").map(Number);
  const m = netmask.split(".").map(Number);
  return a.map((x, i) => (x & m[i]!) | (~m[i]! & 0xff)).join(".");
}

export function scanInterfaces(): { ip: string; broadcast: string }[] {
  const out: { ip: string; broadcast: string }[] = [];
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    if (VIRTUAL.test(name)) continue;
    for (const a of addrs ?? []) {
      if (a.family !== "IPv4" || a.internal || !isPrivate(a.address)) continue;
      out.push({ ip: a.address, broadcast: broadcastOf(a.address, a.netmask) });
    }
  }
  return out;
}

export async function scanBroadlink(waitMs = 2500): Promise<BroadlinkFound[]> {
  const found = new Map<string, BroadlinkFound>();
  const sockets = scanInterfaces().map(
    ({ ip, broadcast }) =>
      new Promise<void>((resolve) => {
        const socket = createSocket({ type: "udp4", reuseAddr: true });
        const done = () => {
          try {
            socket.close();
          } catch {
            // already closed
          }
          resolve();
        };
        socket.on("error", done);
        socket.on("message", (msg, rinfo) => {
          const device = parseHelloReply(new Uint8Array(msg), rinfo.address);
          if (device && isPrivate(device.host)) found.set(device.mac, device);
        });
        socket.bind(0, ip, () => {
          try {
            socket.setBroadcast(true);
            const packet = helloPacket(ip, socket.address().port, new Date());
            for (const to of [broadcast, "255.255.255.255"])
              socket.send(packet, BROADLINK_PORT, to);
          } catch {
            return done();
          }
          setTimeout(done, waitMs);
        });
      }),
  );
  await Promise.all(sockets);
  return [...found.values()];
}

import type { HomeSnapshot } from "@/core/home/model";

/**
 * What Hogar on Desktop needs to keep working without ELISE Cloud (ADR-081): which provider
 * device each ELISE device is, and whether the cloud is down right now.
 */
let keys: Record<string, string> = {};
let names: Record<string, string> = {};
let down = false;
const listeners = new Set<(deviceId: string, state: unknown) => void>();

export const localHome = {
  set(snapshot: HomeSnapshot, providerKeys: Record<string, string>) {
    keys = providerKeys;
    names = Object.fromEntries(snapshot.devices.map((d) => [d.id, d.name]));
  },
  setCloudDown(value: boolean) {
    down = value;
  },
  cloudDown: () => down,
  device: (deviceId: string) =>
    keys[deviceId] ? { providerKey: keys[deviceId]!, name: names[deviceId] ?? "" } : null,
  /** A local control succeeded: screens holding the snapshot update that device. */
  applied(deviceId: string, state: unknown) {
    for (const l of listeners) l(deviceId, state);
  },
  onApplied(l: (deviceId: string, state: unknown) => void) {
    listeners.add(l);
    return () => void listeners.delete(l);
  },
};

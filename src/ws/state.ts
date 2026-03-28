import type WebSocket from "ws";

export type DeviceState = Record<string, unknown>;

export const deviceSockets = new Map<string, WebSocket>();
export const viewerSockets = new Map<string, Set<WebSocket>>();
export const deviceState = new Map<string, DeviceState>();

export function broadcastToViewers(key: string, payload: unknown): void {
  const json = JSON.stringify(payload);
  for (const ws of viewerSockets.get(key) ?? []) {
    if (ws.readyState === 1) ws.send(json);
  }
}

const REPLACE_KEYS = new Set(["wifi", "sensors", "modems", "netif"]);

export function mergeDeviceState(key: string, data: DeviceState): void {
  const current = deviceState.get(key) ?? {};
  const next: DeviceState = { ...current };
  for (const [k, v] of Object.entries(data)) {
    if (
      !REPLACE_KEYS.has(k) &&
      typeof v === "object" &&
      v !== null &&
      !Array.isArray(v) &&
      typeof current[k] === "object" &&
      current[k] !== null &&
      !Array.isArray(current[k])
    ) {
      next[k] = {
        ...(current[k] as Record<string, unknown>),
        ...(v as Record<string, unknown>),
      };
    } else {
      next[k] = v;
    }
  }
  deviceState.set(key, next);
}

export function getDeviceState(key: string): DeviceState {
  return deviceState.get(key) ?? {};
}

export function clearDeviceState(key: string): void {
  deviceState.delete(key);
}

import type WebSocket from "ws";
import type { IncomingMessage } from "http";
import {
  deviceSockets,
  broadcastToViewers,
  mergeDeviceState,
  clearDeviceState,
} from "./state.js";

const REMOTE_PROTOCOL_VERSION = 16;

export async function handleDeviceConnection(
  ws: WebSocket,
  _req: IncomingMessage,
): Promise<void> {
  let deviceKey: string | null = null;
  let authenticated = false;
  let keepaliveTimer: ReturnType<typeof setInterval> | null = null;

  ws.on("message", (raw: Buffer | string) => {
    if (raw.length > 65_536) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (typeof msg.remote === "object" && msg.remote !== null) {
      const remote = msg.remote as Record<string, unknown>;

      if (remote["auth/encoder"]) {
        const auth = remote["auth/encoder"] as Record<string, unknown>;
        const key = auth.key as string | undefined;

        if (!key) {
          ws.send(JSON.stringify({ remote: { "auth/encoder": false } }));
          ws.close(1008, "missing key");
          return;
        }

        deviceKey = key;
        authenticated = true;
        deviceSockets.set(key, ws);

        ws.send(JSON.stringify({ remote: { "auth/encoder": true } }));
        ws.send(
          JSON.stringify({ remote: { relays: { servers: {}, accounts: {} } } }),
        );

        broadcastToViewers(key, { _rencoder: { deviceOnline: true } });

        keepaliveTimer = setInterval(() => {
          if (ws.readyState === 1) ws.send("{}");
        }, 4_000);
        return;
      }

      if (authenticated && deviceKey) {
        for (const [field, value] of Object.entries(remote)) {
          if (field !== "auth/encoder") forward(deviceKey, field, value);
        }
      }
      return;
    }

    if (!authenticated || !deviceKey) return;
    for (const [field, value] of Object.entries(msg))
      forward(deviceKey, field, value);
  });

  ws.on("close", () => {
    if (!deviceKey) return;
    if (keepaliveTimer) clearInterval(keepaliveTimer);

    const key = deviceKey;
    const closedWs = ws;

    setTimeout(() => {
      if (deviceSockets.get(key) !== closedWs) return;
      deviceSockets.delete(key);
      clearDeviceState(key);
      broadcastToViewers(key, { _rencoder: { deviceOnline: false } });
    }, 4_000);
  });

  ws.on("error", () => {});
}

function forward(key: string, field: string, value: unknown): void {
  mergeDeviceState(key, { [field]: value });
  broadcastToViewers(key, { [field]: value });
}

export function sendCommandToDevice(
  deviceKey: string,
  command: Record<string, unknown>,
): boolean {
  const ws = deviceSockets.get(deviceKey);
  if (!ws || ws.readyState !== 1) return false;
  ws.send(JSON.stringify(command));
  return true;
}

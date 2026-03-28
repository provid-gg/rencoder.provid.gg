import type WebSocket from "ws";
import type { IncomingMessage } from "http";
import { viewerSockets, getDeviceState, deviceSockets } from "./state.js";
import { sendCommandToDevice } from "./device.js";

export async function handleViewerConnection(
  ws: WebSocket,
  _req: IncomingMessage,
  deviceKey: string,
): Promise<void> {
  if (!viewerSockets.has(deviceKey)) viewerSockets.set(deviceKey, new Set());
  viewerSockets.get(deviceKey)!.add(ws);

  ws.send(
    JSON.stringify({
      _rencoder: {
        deviceOnline: deviceSockets.has(deviceKey),
      },
    }),
  );

  for (const [field, value] of Object.entries(getDeviceState(deviceKey))) {
    ws.send(JSON.stringify({ [field]: value }));
  }

  ws.on("message", (raw: Buffer | string) => {
    if (raw.length > 65_536) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg._rencoder !== undefined) return;
    if (msg.keepalive !== undefined) return;
    if (!sendCommandToDevice(deviceKey, msg)) {
      if (!deviceSockets.has(deviceKey)) {
        ws.send(JSON.stringify({ _rencoder: { warning: "device_offline" } }));
      }
    }
  });

  ws.on("close", () => {
    viewerSockets.get(deviceKey)?.delete(ws);
    if (viewerSockets.get(deviceKey)?.size === 0)
      viewerSockets.delete(deviceKey);
  });

  ws.on("error", () => {});
}

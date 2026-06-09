import "dotenv/config";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import express from "express";
import { WebSocketServer } from "ws";
import { apiRouter } from "./routes/api.js";
import { proxyMiddleware } from "./routes/proxy.js";
import { handleDeviceConnection } from "./ws/device.js";
import { handleViewerConnection } from "./ws/viewer.js";
import { handleBackpackTunnel, deviceOnline } from "./ws/tunnel.js";
import { allow } from "./ratelimit.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const _rawPort = process.env.PORT ?? "3000";
const PORT = Number(_rawPort);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error(
    `[server] Invalid PORT "${_rawPort}" — must be an integer between 1 and 65535.`,
  );
  process.exit(1);
}

const PUBLIC = path.resolve(__dirname, "../public");

const app = express();
app.set("trust proxy", 1);

app.use("/control/bpos", proxyMiddleware);

app.use(express.json());
app.use(express.static(PUBLIC));

app.get("/internal-api/heartbeat", (_req, res) => res.json({ ok: true }));

app.get("/internal-api/bpos/:key/online", (req, res) =>
  res.json({ isOnline: deviceOnline(req.params.key) }),
);

app.use("/api", apiRouter);

app.get("/connect", (_req, res) =>
  res.sendFile(path.join(PUBLIC, "connect.html")),
);

const SAFE_ENCODER = /^[a-z0-9_-]+$/i;

app.get("/control/:encoder/:key", (req, res) => {
  const encoder = String(req.params.encoder);
  if (!SAFE_ENCODER.test(encoder)) {
    res.status(404).send("Encoder not found");
    return;
  }
  res.sendFile(
    path.join(PUBLIC, "encoders", encoder, "control.html"),
    (err) => {
      if (err) res.status(404).send("Encoder not found");
    },
  );
});

const server = http.createServer(app);

const wss = new WebSocketServer({ server, path: undefined });

function validateOrigin(req: http.IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function wsClientIp(req: http.IncomingMessage): string {
  const fwd = req.headers["x-forwarded-for"];
  const first = Array.isArray(fwd) ? fwd[0] : fwd?.split(",")[0];
  return first?.trim() ?? req.socket.remoteAddress ?? "unknown";
}

wss.on("connection", (ws, req) => {
  if (!validateOrigin(req)) {
    ws.close(1008, "forbidden origin");
    return;
  }
  const url = req.url ?? "";
  const ip = wsClientIp(req);

  if (
    url === "/ws/backpackosremote" ||
    url.startsWith("/ws/backpackosremote?")
  ) {
    if (!allow(ip, 10, 60_000)) {
      ws.close(1008, "rate limited");
      return;
    }
    handleBackpackTunnel(ws, req).catch(() =>
      ws.close(1011, "internal error"),
    );
    return;
  }

  if (
    url === "/ws/belaboxremote" ||
    url.startsWith("/ws/belaboxremote?")
  ) {
    if (!allow(ip, 10, 60_000)) {
      ws.close(1008, "rate limited");
      return;
    }
    handleDeviceConnection(ws, req).catch(() =>
      ws.close(1011, "internal error"),
    );
    return;
  }

  const viewerMatch = url.match(/^\/ws\/viewer\/([^/?]+)/);
  if (viewerMatch) {
    if (!allow(ip, 30, 60_000)) {
      ws.close(1008, "rate limited");
      return;
    }
    const deviceKey = viewerMatch[1];
    handleViewerConnection(ws, req, deviceKey).catch(() =>
      ws.close(1011, "internal error"),
    );
    return;
  }

  ws.close(1003, "unknown endpoint");
});

server.listen(PORT, () => {
  console.log(`Remote Encoder running at http://localhost:${PORT}`);
  console.log(`Device WS:  ws://localhost:${PORT}/ws/belaboxremote`);
  console.log(`Device WS:  ws://localhost:${PORT}/ws/backpackosremote`);
  console.log(`Viewer WS:  ws://localhost:${PORT}/ws/viewer/:key\n`);
});

function shutdown(signal: string) {
  console.log(`${signal} received — shutting down`);
  server.close(() => process.exit(0));
  for (const client of wss.clients) client.terminate();
  setTimeout(() => process.exit(0), 2_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

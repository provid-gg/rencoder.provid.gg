import type WebSocket from "ws";
import type { IncomingMessage, ServerResponse } from "http";

interface PendingRequest {
  onHead: (status: number, headers: Record<string, string[]>) => void;
  onBody: (chunk: Buffer) => void;
  onEnd: (error?: string) => void;
}

interface Tunnel {
  ws: WebSocket;
  pending: Map<string, PendingRequest>;
  send: (frame: unknown) => void;
}

const tunnels = new Map<string, Tunnel>();

let reqCounter = 0;
function nextRequestId(): string {
  reqCounter = (reqCounter + 1) % Number.MAX_SAFE_INTEGER;
  return `${Date.now().toString(36)}-${reqCounter.toString(36)}`;
}

export function deviceOnline(key: string): boolean {
  const t = tunnels.get(key);
  return !!t && t.ws.readyState === 1;
}

export async function handleBackpackTunnel(
  ws: WebSocket,
  _req: IncomingMessage,
): Promise<void> {
  let key: string | null = null;
  let authenticated = false;
  let keepaliveTimer: ReturnType<typeof setInterval> | null = null;

  const cleanup = () => {
    if (keepaliveTimer) clearInterval(keepaliveTimer);
    if (!key) return;
    const t = tunnels.get(key);
    if (t && t.ws === ws) {
      tunnels.delete(key);
      for (const p of t.pending.values()) p.onEnd("device_disconnected");
      t.pending.clear();
    }
  };

  ws.on("message", (raw: Buffer | string) => {
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
        const k = auth.key as string | undefined;
        if (!k) {
          ws.send(JSON.stringify({ remote: { "auth/encoder": false } }));
          ws.close(1008, "missing key");
          return;
        }
        const prev = tunnels.get(k);
        if (prev && prev.ws !== ws) prev.ws.close(1012, "superseded");
        key = k;
        authenticated = true;
        const tunnel: Tunnel = {
          ws,
          pending: new Map(),
          send: (frame) => {
            if (ws.readyState === 1) ws.send(JSON.stringify(frame));
          },
        };
        tunnels.set(k, tunnel);
        ws.send(JSON.stringify({ remote: { "auth/encoder": true } }));
        keepaliveTimer = setInterval(() => {
          if (ws.readyState === 1) ws.send("{}");
        }, 4_000);
      }
      return;
    }

    if (!authenticated || !key) return;
    const t = tunnels.get(key);
    if (!t) return;

    const head = msg["bpos/head"] as
      | { id: string; status: number; headers: Record<string, string[]> }
      | undefined;
    if (head) {
      t.pending.get(head.id)?.onHead(head.status, head.headers || {});
      return;
    }
    const body = msg["bpos/body"] as { id: string; data: string } | undefined;
    if (body) {
      t.pending.get(body.id)?.onBody(Buffer.from(body.data, "base64"));
      return;
    }
    const end = msg["bpos/end"] as { id: string; error?: string } | undefined;
    if (end) {
      const p = t.pending.get(end.id);
      if (p) {
        t.pending.delete(end.id);
        p.onEnd(end.error);
      }
    }
  });

  ws.on("close", cleanup);
  ws.on("error", () => {});
}

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-length",
  "te",
  "trailer",
  "upgrade",
  "proxy-authenticate",
  "proxy-authorization",
]);

function rewriteSetCookie(
  values: string[],
  pathPrefix: string,
  secure: boolean,
): string[] {
  return values.map((c) => {
    let out = c.replace(/;\s*[Pp]ath=[^;]*/g, "");
    out = out.replace(/;\s*[Ss]ecure\b/g, "");
    out = `${out}; Path=${pathPrefix}`;
    if (secure) out += "; Secure";
    return out;
  });
}

export function proxyToDevice(
  key: string,
  devicePath: string,
  req: IncomingMessage,
  res: ServerResponse,
  body: Buffer,
  pathPrefix: string,
  secure: boolean,
): void {
  const t = tunnels.get(key);
  if (!t || t.ws.readyState !== 1) {
    res.statusCode = 503;
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.end("Device offline — it is not connected to Remote Encoder right now.");
    return;
  }

  const id = nextRequestId();
  const headers: Record<string, string[]> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (HOP_BY_HOP.has(name.toLowerCase())) continue;
    headers[name] = Array.isArray(value) ? value : [value];
  }

  let ended = false;
  const finish = () => {
    if (ended) return;
    ended = true;
    t.pending.delete(id);
    if (!res.writableEnded) res.end();
  };

  t.pending.set(id, {
    onHead: (status, respHeaders) => {
      res.statusCode = status;
      for (const [name, values] of Object.entries(respHeaders)) {
        const lower = name.toLowerCase();
        if (HOP_BY_HOP.has(lower)) continue;
        if (lower === "set-cookie") {
          res.setHeader("set-cookie", rewriteSetCookie(values, pathPrefix, secure));
          continue;
        }
        res.setHeader(name, values.length === 1 ? values[0] : values);
      }
      res.flushHeaders();
    },
    onBody: (chunk) => {
      if (!res.writableEnded) res.write(chunk);
    },
    onEnd: () => finish(),
  });

  t.send({
    "bpos/req": {
      id,
      method: req.method || "GET",
      path: devicePath,
      headers,
      body: body.length ? body.toString("base64") : "",
    },
  });

  const cancel = () => {
    if (ended) return;
    t.send({ "bpos/cancel": { id } });
    finish();
  };
  res.on("close", () => {
    if (!ended && !res.writableEnded) cancel();
  });
}

import type { Request, Response, NextFunction } from "express";
import type { IncomingMessage } from "http";
import { proxyToDevice } from "../ws/tunnel.js";

const SAFE_KEY = /^[a-zA-Z0-9_-]+$/;
const MAX_BODY = 2 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export async function proxyMiddleware(
  req: Request,
  res: Response,
  _next: NextFunction,
): Promise<void> {
  const urlPath = req.url;
  const slash = urlPath.indexOf("/", 1);
  const qmark = urlPath.indexOf("?");
  let keyEnd = urlPath.length;
  if (slash !== -1) keyEnd = Math.min(keyEnd, slash);
  if (qmark !== -1) keyEnd = Math.min(keyEnd, qmark);

  const key = urlPath.slice(1, keyEnd);
  if (!SAFE_KEY.test(key)) {
    res.status(404).send("Not found");
    return;
  }

  let devicePath = urlPath.slice(1 + key.length);
  if (devicePath === "") {
    res.redirect(302, `/control/bpos/${key}/`);
    return;
  }
  if (devicePath.startsWith("?")) devicePath = "/" + devicePath;

  let body: Buffer;
  try {
    body =
      req.method === "GET" || req.method === "HEAD"
        ? Buffer.alloc(0)
        : await readBody(req);
  } catch {
    res.status(413).send("Payload too large");
    return;
  }

  proxyToDevice(key, devicePath, req, res, body, `/control/bpos/${key}/`, req.secure);
}

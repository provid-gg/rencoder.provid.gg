import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { deviceSockets } from "../ws/state.js";
import { allow } from "../ratelimit.js";

export const apiRouter = Router();

function statusRateLimit(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const ip = req.ip ?? req.socket.remoteAddress ?? "unknown";
  if (!allow(ip, 60, 60_000)) {
    res.status(429).json({ error: "Too many requests" });
    return;
  }
  next();
}

apiRouter.get("/devices/:key/status", statusRateLimit, (req, res) => {
  const key = String(req.params.key);
  res.json({ isOnline: deviceSockets.has(key) });
});

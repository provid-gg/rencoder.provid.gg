const buckets = new Map<string, { count: number; reset: number }>();

setInterval(() => {
  const now = Date.now();
  for (const [key, b] of buckets) {
    if (now > b.reset) buckets.delete(key);
  }
}, 300_000).unref();

export function allow(ip: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const b = buckets.get(ip);
  if (!b || now > b.reset) {
    buckets.set(ip, { count: 1, reset: now + windowMs });
    return true;
  }
  if (b.count >= max) return false;
  b.count++;
  return true;
}

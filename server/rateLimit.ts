import type { Request, Response, NextFunction } from 'express';

const WINDOW_MS = 60_000;
const MAX_HITS = 400;
const buckets = new Map<string, { count: number; resetAt: number }>();

function clientKey(req: Request): string {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.ip || req.socket.remoteAddress || 'local';
}

/**
 * Cheap per-IP ceiling so a stuck client loop cannot
 * hammer the open-data services through us. Health stays outside the limiter.
 * The report panel polls about once a second, hence the headroom.
 * Map tiles are exempt: one window is ~120 of them, and they are
 * served from the disk cache with a fixed whitelist of layers.
 */
export function rateLimit(req: Request, res: Response, next: NextFunction): void {
  if (
    !req.path.startsWith('/api') ||
    req.path.startsWith('/api/tiles/') ||
    req.path === '/api/health' ||
    req.path === '/api/health/sources'
  ) {
    next();
    return;
  }

  const now = Date.now();
  const key = clientKey(req);
  const bucket = buckets.get(key);

  if (!bucket || now >= bucket.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
    next();
    return;
  }

  bucket.count += 1;
  if (bucket.count > MAX_HITS) {
    res.setHeader('Retry-After', String(Math.ceil((bucket.resetAt - now) / 1000)));
    res.status(429).json({ error: 'Pārāk daudz pieprasījumu. Uzgaidi minūti.' });
    return;
  }

  next();
}

// Fixed-window per-user limits for routes that spend money (Claude) or
// Google quota. Stored in Postgres so every serverless instance agrees.

export const LIMITS = {
  chat: { perMinute: 12, perDay: 400 },
  classify: { perMinute: 40, perDay: 2000 },
  search: { perMinute: 40, perDay: 3000 },
  briefing: { perMinute: 4, perDay: 60 },
  // Connected apps (bearer token): the app's poll, photo downloads, pairing.
  appsync: { perMinute: 30, perDay: 20000 },
  appfile: { perMinute: 120, perDay: 5000 },
  pair: { perMinute: 10, perDay: 200 },
};

export class RateLimitError extends Error {
  constructor(bucket, retryAfter) { super('rate limited'); this.bucket = bucket; this.retryAfter = retryAfter; this.publicMessage = 'Slow down a little — try again in ' + retryAfter + ' seconds.'; }
}

async function hit(db, userId, bucket, windowSec, max, now) {
  const start = new Date(Math.floor(now / (windowSec * 1000)) * windowSec * 1000);
  const r = await db.query(`INSERT INTO asst_rate (user_id, bucket, window_start, count) VALUES ($1,$2,$3,1)
      ON CONFLICT (user_id, bucket, window_start) DO UPDATE SET count = asst_rate.count + 1 RETURNING count`,
    [userId, bucket + ':' + windowSec, start]);
  if (r[0].count > max) throw new RateLimitError(bucket, Math.max(1, Math.ceil((start.getTime() + windowSec * 1000 - now) / 1000)));
}

export async function checkRate(db, userId, bucket, now = Date.now(), limits = LIMITS) {
  const l = limits[bucket];
  if (!l) return;
  await hit(db, userId, bucket, 60, l.perMinute, now);
  await hit(db, userId, bucket, 86400, l.perDay, now);
  // Old windows are cleared opportunistically (1 request in 50).
  if (Math.random() < 0.02) db.query("DELETE FROM asst_rate WHERE window_start < now() - interval '2 days'").catch(() => {});
}

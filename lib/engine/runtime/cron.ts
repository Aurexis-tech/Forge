// Minimal cron-next helper.
//
// V1 supports a SUBSET of cron expressions — enough for common scheduling
// patterns — and falls back to "every 5 minutes" for anything it doesn't
// understand. Documented in the runtime README; richer scheduling is a
// future enhancement.
//
// Supported:
//   * * * * *           — every minute
//   *​/N * * * *          — every N minutes (e.g. *​/5 * * * *)
//   0 * * * *           — top of every hour
//   0 *​/N * * *          — every N hours (e.g. 0 *​/2 * * *)
//   M H * * *           — daily at H:M (e.g. 30 9 * * * → 09:30 daily)
//   0 0 * * *           — daily at midnight UTC
//
// Anything else returns +5 minutes.

const FALLBACK_INTERVAL_MS = 5 * 60_000;

export function nextRunFromCron(
  expression: string,
  fromTime: Date = new Date(),
): Date {
  const cron = expression.trim();
  if (cron === '* * * * *') {
    return alignToNextMinute(fromTime, 1);
  }

  const parts = cron.split(/\s+/);
  if (parts.length !== 5) {
    return new Date(fromTime.getTime() + FALLBACK_INTERVAL_MS);
  }
  const [min, hour, dom, mon, dow] = parts;

  const wildcardDate = dom === '*' && mon === '*' && dow === '*';

  // */N minutes
  const everyNMin = /^\*\/(\d+)$/.exec(min ?? '');
  if (everyNMin && hour === '*' && wildcardDate) {
    const n = clampInterval(Number(everyNMin[1]));
    return alignToNextMinute(fromTime, n);
  }

  // 0 * * * * → top of next hour
  if (min === '0' && hour === '*' && wildcardDate) {
    return alignToNextHour(fromTime, 1);
  }

  // 0 */N * * *
  const everyNHour = /^\*\/(\d+)$/.exec(hour ?? '');
  if (min === '0' && everyNHour && wildcardDate) {
    const n = clampInterval(Number(everyNHour[1]));
    return alignToNextHour(fromTime, n);
  }

  // M H * * * (daily at H:M)
  if (/^\d+$/.test(min ?? '') && /^\d+$/.test(hour ?? '') && wildcardDate) {
    const next = new Date(fromTime);
    next.setUTCSeconds(0, 0);
    next.setUTCMinutes(Number(min));
    next.setUTCHours(Number(hour));
    if (next.getTime() <= fromTime.getTime()) {
      next.setUTCDate(next.getUTCDate() + 1);
    }
    return next;
  }

  return new Date(fromTime.getTime() + FALLBACK_INTERVAL_MS);
}

function alignToNextMinute(fromTime: Date, intervalMinutes: number): Date {
  const next = new Date(fromTime);
  next.setUTCSeconds(0, 0);
  const m = next.getUTCMinutes();
  const remainder = m % intervalMinutes;
  // Round up; if we're exactly on the boundary, push to the next slot so we
  // don't accidentally re-run the same minute we were just woken in.
  next.setUTCMinutes(m - remainder + intervalMinutes);
  return next;
}

function alignToNextHour(fromTime: Date, intervalHours: number): Date {
  const next = new Date(fromTime);
  next.setUTCMinutes(0, 0, 0);
  const h = next.getUTCHours();
  const remainder = h % intervalHours;
  next.setUTCHours(h - remainder + intervalHours);
  return next;
}

function clampInterval(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 5;
  if (n > 60) return 60;
  return n;
}

// Human-readable summary for the UI.
export function describeCron(expression: string): string {
  const cron = expression.trim();
  if (cron === '* * * * *') return 'every minute';

  const parts = cron.split(/\s+/);
  if (parts.length !== 5) return cron;
  const [min, hour, dom, mon, dow] = parts;
  const wildcardDate = dom === '*' && mon === '*' && dow === '*';

  const everyNMin = /^\*\/(\d+)$/.exec(min ?? '');
  if (everyNMin && hour === '*' && wildcardDate) {
    const n = clampInterval(Number(everyNMin[1]));
    return 'every ' + n + ' minute' + (n === 1 ? '' : 's');
  }
  if (min === '0' && hour === '*' && wildcardDate) return 'every hour';

  const everyNHour = /^\*\/(\d+)$/.exec(hour ?? '');
  if (min === '0' && everyNHour && wildcardDate) {
    const n = clampInterval(Number(everyNHour[1]));
    return 'every ' + n + ' hour' + (n === 1 ? '' : 's');
  }

  if (/^\d+$/.test(min ?? '') && /^\d+$/.test(hour ?? '') && wildcardDate) {
    return (
      'daily at ' +
      String(hour).padStart(2, '0') +
      ':' +
      String(min).padStart(2, '0') +
      ' UTC'
    );
  }

  return cron;
}

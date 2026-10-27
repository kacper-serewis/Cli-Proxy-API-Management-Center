/**
 * Pooled quota: the sum of every credential's long (weekly) window for one provider.
 *
 * Per-credential cards answer "how much is left on this account"; the pool answers
 * "how much is left across all of them, and when does it run out". Recorded values come
 * from the proxy's quota history (GET /observability/quota-history); the projection
 * spends the recent burn rate the way the soonest-reset router does — always from the
 * credential whose window resets first — and refills each credential at its reset.
 *
 * Pure functions only: `now` is always passed in.
 */

import { HOUR_MS } from '@/utils/time/durations';

/** One observation recorded by the proxy. Usage is a 0..1 fraction; resets are unix seconds. */
export interface PoolHistoryPoint {
  t: number;
  auth: string;
  provider: string;
  long_used: number;
  long_reset: number;
  short_used?: number;
  short_reset?: number;
}

export interface PoolAccount {
  name: string;
  displayName: string;
  /** Percent left in the long window right now, 0..100. */
  remaining: number;
  /** Next long-window reset, or null when unknown. */
  resetAtMs: number | null;
  periodHours: number;
}

export interface PoolSeriesPoint {
  t: number;
  /** Pool remaining, 0..100 × accounts. */
  v: number;
}

export interface PoolResetMark {
  t: number;
  /** Percentage points the reset gives back. */
  gain: number;
  /** Pool value right after the reset, for placing the label. */
  v: number;
}

export interface PoolProjection {
  series: PoolSeriesPoint[];
  resets: PoolResetMark[];
  firstEmpty: { name: string; t: number } | null;
  poolEmptyAt: number | null;
}

export const WEEK_HOURS = 24 * 7;
const PROJECTION_STEP_MS = 10 * 60 * 1000;
/** Resets that give back less than this are not worth a label. */
const MIN_LABELLED_GAIN = 0.5;

const clamp = (value: number) => Math.min(100, Math.max(0, value));

const remainingAt = (point: PoolHistoryPoint, t: number) =>
  point.long_reset * 1000 <= t ? 100 : clamp(100 - point.long_used * 100);

/** Group history by credential, oldest first. */
export function historyByAccount(points: PoolHistoryPoint[]): Map<string, PoolHistoryPoint[]> {
  const byAccount = new Map<string, PoolHistoryPoint[]>();
  for (const point of points) {
    const list = byAccount.get(point.auth) ?? [];
    list.push(point);
    byAccount.set(point.auth, list);
  }
  for (const list of byAccount.values()) list.sort((a, b) => a.t - b.t);
  return byAccount;
}

/**
 * Current state for a credential whose live quota isn't loaded, from its newest recorded
 * point. A reset that has since passed means the window is full again.
 */
export function accountFromHistory(
  name: string,
  displayName: string,
  points: PoolHistoryPoint[] | undefined,
  now: number,
  periodHours = WEEK_HOURS
): PoolAccount | null {
  const latest = points?.[points.length - 1];
  if (!latest) return null;
  let resetAtMs = latest.long_reset * 1000;
  const periodMs = periodHours * HOUR_MS;
  while (resetAtMs <= now) resetAtMs += periodMs;
  return { name, displayName, remaining: remainingAt(latest, now), resetAtMs, periodHours };
}

/** Value of one credential at `t`, carrying its first observation backwards. */
function accountValueAt(points: PoolHistoryPoint[], t: number): number {
  let current = points[0];
  for (const point of points) {
    if (point.t * 1000 > t) break;
    current = point;
  }
  return remainingAt(current, t);
}

/**
 * Recorded pool line from `fromMs` to `now`, ending on the live values. Credentials without
 * history contribute their live value throughout, so the line stays on the same scale as
 * the projection.
 */
export function recordedSeries(
  accounts: PoolAccount[],
  history: Map<string, PoolHistoryPoint[]>,
  fromMs: number,
  now: number
): { series: PoolSeriesPoint[]; resets: PoolResetMark[] } {
  if (fromMs >= now) return { series: [], resets: [] };
  const tracked = accounts.map((account) => ({ account, points: history.get(account.name) ?? [] }));

  const events = new Set<number>([fromMs]);
  for (const { points } of tracked) {
    for (const point of points) {
      for (const at of [point.t * 1000, point.long_reset * 1000]) {
        if (at > fromMs && at < now) events.add(at);
      }
    }
  }
  const total = (t: number) =>
    tracked.reduce(
      (sum, { account, points }) =>
        sum + (points.length > 0 ? accountValueAt(points, t) : account.remaining),
      0
    );

  const series: PoolSeriesPoint[] = [];
  const resets: PoolResetMark[] = [];
  for (const at of [...events].sort((a, b) => a - b)) {
    const before = at === fromMs ? null : total(at - 1);
    const after = total(at);
    if (before !== null && before !== after) {
      series.push({ t: at, v: before });
      if (after - before >= MIN_LABELLED_GAIN)
        resets.push({ t: at, gain: after - before, v: after });
    }
    series.push({ t: at, v: after });
  }
  series.push({ t: now, v: accounts.reduce((sum, account) => sum + account.remaining, 0) });
  return { series, resets };
}

/**
 * Percentage points consumed per hour across the pool over the last `windowHours`.
 * Only increases in usage within the same reset window count; a reset is not "negative
 * burn". The live values extend the last recorded point to `now`.
 */
export function burnRatePerHour(
  accounts: PoolAccount[],
  history: Map<string, PoolHistoryPoint[]>,
  windowHours: number,
  now: number
): number {
  const startMs = now - windowHours * HOUR_MS;
  let consumed = 0;
  for (const account of accounts) {
    const points = history.get(account.name) ?? [];
    // Start from the last observation at or before the window so usage that happened
    // inside the window is counted even if only one point falls in it.
    let prev: { used: number; reset: number } | null = null;
    for (const point of points) {
      const current = { used: point.long_used * 100, reset: point.long_reset };
      if (point.t * 1000 <= startMs) {
        prev = current;
        continue;
      }
      if (point.t * 1000 > now) break;
      if (prev && prev.reset === current.reset) consumed += Math.max(0, current.used - prev.used);
      prev = current;
    }
    if (prev && account.resetAtMs !== null && Math.round(account.resetAtMs / 1000) === prev.reset) {
      consumed += Math.max(0, 100 - account.remaining - prev.used);
    }
  }
  return windowHours > 0 ? consumed / windowHours : 0;
}

/**
 * Project the pool forward to `endMs` at a constant burn rate. Usage is drawn from the
 * credential that resets soonest and still has quota, which is how soonest-reset routing
 * spends it; each credential refills to 100% at its reset and its next window starts.
 */
export function projectPool(
  accounts: PoolAccount[],
  burnPerHour: number,
  now: number,
  endMs: number
): PoolProjection {
  const state = accounts.map((account) => ({
    name: account.displayName,
    remaining: account.remaining,
    nextReset: account.resetAtMs ?? Number.POSITIVE_INFINITY,
    periodMs: account.periodHours * HOUR_MS,
  }));
  const total = () => state.reduce((sum, account) => sum + account.remaining, 0);
  const series: PoolSeriesPoint[] = [{ t: now, v: total() }];
  const resets: PoolResetMark[] = [];
  let firstEmpty: PoolProjection['firstEmpty'] = null;
  let poolEmptyAt: number | null = total() <= 0 ? now : null;

  let t = now;
  while (t < endMs) {
    const next = Math.min(t + PROJECTION_STEP_MS, endMs);

    // Resets falling inside this step land at their exact instant.
    for (;;) {
      const due = state
        .filter((account) => account.nextReset <= next)
        .sort((a, b) => a.nextReset - b.nextReset)[0];
      if (!due) break;
      const at = due.nextReset;
      const emptiedBefore = drain(state, burnPerHour * ((at - t) / HOUR_MS), at);
      if (!firstEmpty && emptiedBefore) firstEmpty = { name: emptiedBefore, t: at };
      t = at;
      const before = total();
      due.remaining = 100;
      due.nextReset =
        Number.isFinite(due.periodMs) && due.periodMs > 0 ? at + due.periodMs : Infinity;
      const after = total();
      series.push({ t: at, v: before });
      series.push({ t: at, v: after });
      if (after - before >= MIN_LABELLED_GAIN)
        resets.push({ t: at, gain: after - before, v: after });
    }

    const emptied = drain(state, burnPerHour * ((next - t) / HOUR_MS), next);
    if (!firstEmpty && emptied) firstEmpty = { name: emptied, t: next };
    t = next;
    const value = total();
    if (poolEmptyAt === null && value <= 0) poolEmptyAt = t;
    series.push({ t, v: value });
  }
  return { series, resets, firstEmpty, poolEmptyAt };
}

/** Spend `amount` soonest-reset first. Returns the name of a credential this emptied. */
function drain(
  state: { name: string; remaining: number; nextReset: number }[],
  amount: number,
  at: number
): string | null {
  let left = amount;
  let emptied: string | null = null;
  const order = state
    .filter((account) => account.remaining > 0)
    .sort((a, b) => a.nextReset - b.nextReset);
  for (const account of order) {
    if (left <= 0) break;
    const take = Math.min(account.remaining, left);
    account.remaining -= take;
    left -= take;
    if (account.remaining <= 1e-9 && account.nextReset > at) {
      account.remaining = 0;
      emptied ??= account.name;
    }
  }
  return emptied;
}

import type { PoolAccount, PoolProjection } from './quotaPoolModel';
import { HOUR_MS } from '@/utils/time/durations';

// Keep in step with selector_soonest_reset.go and CliproxyBarCore/JointProjection.swift.
export const SHORT_HEADROOM_LIMIT = 90;
export const LONG_HEADROOM_LIMIT = 99;
const STEP = 5 * 60 * 1000;
const EPS = 1e-8;

export interface HeadroomGap {
  start: number;
  end: number | null;
}
export interface JointProjection {
  long: PoolProjection;
  short: PoolProjection;
  gaps: HeadroomGap[];
}

/** One workload consumes both windows on the same seat. Keep observed workload shares
 * while a seat has headroom; move its share to the soonest weekly reset when it fills.
 * Stop spending during a gap (no queued work), resume at resets. Safety thresholds are
 * conservative: fallback requests may still succeed. Rates are midpoint samples, <=5m.
 */
export function projectJointPool(
  longAccounts: PoolAccount[],
  shortAccounts: PoolAccount[],
  longRate: (t: number) => number,
  shortRate: (t: number) => number,
  shares: Map<string, number>,
  now: number,
  end: number
): JointProjection {
  const state = longAccounts.map((long) => {
    const short = shortAccounts.find((a) => a.name === long.name);
    return {
      longUsed: 100 - long.remaining,
      shortUsed: short ? 100 - short.remaining : null,
      longReset: long.resetAtMs ?? Infinity,
      shortReset: short?.resetAtMs ?? Infinity,
      longPeriod: long.periodHours * HOUR_MS,
      shortPeriod: (short?.periodHours ?? 5) * HOUR_MS,
      share: Math.max(0, shares.get(long.name) ?? 0),
    };
  });
  const totalShare = state.reduce((sum, a) => sum + a.share, 0);
  if (totalShare > 0) state.forEach((a) => (a.share /= totalShare));
  const projection = (): PoolProjection => ({
    series: [],
    resets: [],
    firstEmpty: null,
    poolEmptyAt: null,
  });
  const result: JointProjection = { long: projection(), short: projection(), gaps: [] };
  if (state.length === 0) return result;
  const total = (short: boolean) =>
    state.reduce(
      (sum, a) => sum + (short ? (a.shortUsed === null ? 0 : 100 - a.shortUsed) : 100 - a.longUsed),
      0
    );
  const record = (t: number) => {
    result.long.series.push({ t, v: total(false) });
    result.short.series.push({ t, v: total(true) });
  };
  const eligible = (i: number) =>
    state[i].longUsed < LONG_HEADROOM_LIMIT - EPS &&
    (state[i].shortUsed === null || state[i].shortUsed! < SHORT_HEADROOM_LIMIT - EPS);
  let t = now;
  record(t);
  while (t < end) {
    // Reset before assigning work, but never before its actual instant.
    const beforeLong = total(false),
      beforeShort = total(true);
    for (const a of state) {
      if (a.longReset <= t) {
        a.longUsed = 0;
        a.longReset = a.longPeriod > 0 ? t + a.longPeriod : Infinity;
      }
      if (a.shortReset <= t) {
        a.shortUsed = 0;
        a.shortReset = Infinity; // starts on its next use
      }
    }
    for (const [short, before, p] of [
      [false, beforeLong, result.long],
      [true, beforeShort, result.short],
    ] as const) {
      const gain = total(short) - before;
      if (gain > EPS) {
        p.resets.push({ t, gain, v: total(short) });
        record(t);
      }
    }
    const order = state
      .map((_, i) => i)
      .filter(eligible)
      .sort((a, b) => state[a].longReset - state[b].longReset || a - b);
    const nextReset = Math.min(...state.flatMap((a) => [a.longReset, a.shortReset]));
    if (order.length === 0) {
      if (!result.gaps.length || result.gaps[result.gaps.length - 1].end !== null)
        result.gaps.push({ start: t, end: null });
      t = Math.min(end, nextReset);
      record(t);
      continue;
    }
    if (result.gaps.length && result.gaps[result.gaps.length - 1].end === null)
      result.gaps[result.gaps.length - 1].end = t;
    const weights = state.map((a, i) => (eligible(i) ? a.share : 0));
    weights[order[0]] += Math.max(0, 1 - weights.reduce((sum, weight) => sum + weight, 0));
    const next = Math.min(t + STEP, end, nextReset);
    const longBurn = Math.max(0, longRate((t + next) / 2));
    const shortBurn = Math.max(0, shortRate((t + next) / 2));
    let dt = next - t;
    for (const i of order) {
      const a = state[i],
        weight = weights[i];
      if (weight <= 0) continue;
      if (longBurn > 0)
        dt = Math.min(dt, ((LONG_HEADROOM_LIMIT - a.longUsed) / (longBurn * weight)) * HOUR_MS);
      if (shortBurn > 0 && a.shortUsed !== null)
        dt = Math.min(dt, ((SHORT_HEADROOM_LIMIT - a.shortUsed) / (shortBurn * weight)) * HOUR_MS);
    }
    for (const i of order) {
      const a = state[i],
        weight = weights[i];
      if (weight <= 0) continue;
      if (a.shortUsed !== null && a.shortReset === Infinity && (longBurn > 0 || shortBurn > 0))
        a.shortReset = t + a.shortPeriod;
      a.longUsed += (longBurn * weight * dt) / HOUR_MS;
      if (a.shortUsed !== null) a.shortUsed += (shortBurn * weight * dt) / HOUR_MS;
    }
    t += dt;
    record(t);
  }
  return result;
}

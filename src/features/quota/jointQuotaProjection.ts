import type { PoolAccount, PoolProjection } from './quotaPoolModel';
import { HOUR_MS } from '@/utils/time/durations';

// Keep in step with selector_soonest_reset.go and CliproxyBarCore/JointProjection.swift.
export const SHORT_HEADROOM_LIMIT = 90;
export const LONG_HEADROOM_LIMIT = 99;
/** From this weekly usage a seat is kept for overflow: it only takes work when no other
 * seat has headroom. One full 5h window costs about 15 weekly points. */
export const LONG_RESERVE_LIMIT = 84;
/** The reserve is released once the usage expected before the weekly reset is at most
 * this many times what is left, so it is spent, not lost. Held on that line, the seat
 * takes 1/RESERVE_COVER of the work and runs out at its reset. */
export const RESERVE_COVER = 2;
const DEMAND_STEP = 15 * 60 * 1000;
const STEP = 5 * 60 * 1000;
const EPS = 1e-8;

export interface HeadroomGap {
  start: number;
  end: number | null;
  /** Which limit keeps each seat from taking work when the gap starts. */
  blocked?: { name: string; limit: 'short' | 'long' }[];
}

/** One expected period without safe headroom, for the list under the chart. */
export interface HeadroomEvent {
  start: number;
  /** When headroom returns; the end of the projection when it does not within it. */
  end: number;
  /** False when headroom does not return within the projection: it lasts at least this long. */
  ended: boolean;
  /** How much of it falls in working hours. */
  workingMs: number;
  blocked: { name: string; limit: 'short' | 'long' }[];
}

/** Working hours, local time on weekdays: where a gap hurts. */
export const WORK_START_MINUTES = 9 * 60 + 30;
export const WORK_END_MINUTES = 17 * 60 + 30;

/** The part of a period that falls in working hours. */
export function workingTime(start: number, end: number): number {
  let total = 0;
  const day = new Date(start);
  day.setHours(0, 0, 0, 0);
  while (day.getTime() < end) {
    if (day.getDay() >= 1 && day.getDay() <= 5) {
      const from = new Date(day).setHours(0, WORK_START_MINUTES, 0, 0);
      const to = new Date(day).setHours(0, WORK_END_MINUTES, 0, 0);
      total += Math.max(0, Math.min(end, to) - Math.max(start, from));
    }
    day.setDate(day.getDate() + 1);
  }
  return total;
}

/**
 * The gaps that are going on or start before `until`, each with its length. A gap that
 * began earlier counts from `now`; one without an end runs to `projectionEnd`.
 */
export function headroomEvents(
  gaps: HeadroomGap[],
  now: number,
  until: number,
  projectionEnd: number
): HeadroomEvent[] {
  return gaps
    .filter((gap) => gap.start < until && (gap.end === null || gap.end > now))
    .map((gap) => {
      const start = Math.max(gap.start, now);
      const end = gap.end ?? Math.max(projectionEnd, start);
      return {
        start,
        end,
        ended: gap.end !== null,
        workingMs: workingTime(start, end),
        blocked: gap.blocked ?? [],
      };
    });
}
export interface JointProjection {
  long: PoolProjection;
  short: PoolProjection;
  gaps: HeadroomGap[];
}

/** One workload consumes both windows on the same seat. Keep observed workload shares
 * while a seat has headroom; move its share to the soonest weekly reset when it fills.
 * A seat in its weekly reserve hands its share over too and only works when no other
 * seat has headroom (chats already on it are assumed to finish soon). Stop spending
 * during a gap (no queued work), resume at resets. Safety thresholds are conservative:
 * fallback requests may still succeed. Rates are midpoint samples, <=5m.
 */
export function projectJointPool(
  longAccounts: PoolAccount[],
  shortAccounts: PoolAccount[],
  longRate: (t: number) => number,
  shortRate: (t: number) => number,
  shares: Map<string, number>,
  now: number,
  end: number,
  /** Whether `longRate` is a learned rhythm. Without a forecast the router keeps no reserve. */
  reserve = true
): JointProjection {
  const state = longAccounts.map((long) => {
    const short = shortAccounts.find((a) => a.name === long.name);
    return {
      name: long.name,
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
  // Usage expected from now, cumulative on a 15-minute grid that grows as far as needed.
  const cumulative = [0];
  const demandBy = (at: number) => {
    const steps = Math.max(0, (at - now) / DEMAND_STEP);
    const last = Math.min(Math.ceil(steps), 4 * 24 * 60); // weekly resets lie within 60 days
    while (cumulative.length <= last) {
      const from = now + (cumulative.length - 1) * DEMAND_STEP;
      const burn = Math.max(0, longRate(from + DEMAND_STEP / 2)) * (DEMAND_STEP / HOUR_MS);
      cumulative.push(cumulative[cumulative.length - 1] + burn);
    }
    const floor = Math.min(Math.floor(steps), last);
    return cumulative[floor] + (cumulative[last] - cumulative[floor]) * (steps - floor);
  };
  const reserved = (i: number, at: number) =>
    reserve &&
    state[i].longUsed >= LONG_RESERVE_LIMIT - EPS &&
    Number.isFinite(state[i].longReset) &&
    demandBy(state[i].longReset) - demandBy(at) >
      RESERVE_COVER * (LONG_HEADROOM_LIMIT - state[i].longUsed) + EPS;
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
    const open = state.map((_, i) => i).filter(eligible);
    const free = open.filter((i) => !reserved(i, t));
    // Reserved seats take the overflow only when no other seat has headroom.
    const order = (free.length > 0 ? free : open).sort(
      (a, b) => state[a].longReset - state[b].longReset || a - b
    );
    const nextReset = Math.min(...state.flatMap((a) => [a.longReset, a.shortReset]));
    if (order.length === 0) {
      if (!result.gaps.length || result.gaps[result.gaps.length - 1].end !== null)
        result.gaps.push({
          start: t,
          end: null,
          blocked: state.map((a) => ({
            name: a.name,
            limit: a.longUsed >= LONG_HEADROOM_LIMIT - EPS ? 'long' : 'short',
          })),
        });
      t = Math.min(end, nextReset);
      record(t);
      continue;
    }
    if (result.gaps.length && result.gaps[result.gaps.length - 1].end === null)
      result.gaps[result.gaps.length - 1].end = t;
    const weights = state.map((a, i) => (order.includes(i) ? a.share : 0));
    weights[order[0]] += Math.max(0, 1 - weights.reduce((sum, weight) => sum + weight, 0));
    const next = Math.min(t + STEP, end, nextReset);
    const longBurn = Math.max(0, longRate((t + next) / 2));
    const shortBurn = Math.max(0, shortRate((t + next) / 2));
    let dt = next - t;
    for (const i of order) {
      const a = state[i],
        weight = weights[i];
      if (weight <= 0) continue;
      if (longBurn > 0) {
        // Stop where the seat enters its reserve, so that is decided at the threshold.
        const limit =
          reserve && a.longUsed < LONG_RESERVE_LIMIT - EPS ? LONG_RESERVE_LIMIT : LONG_HEADROOM_LIMIT;
        dt = Math.min(dt, ((limit - a.longUsed) / (longBurn * weight)) * HOUR_MS);
      }
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

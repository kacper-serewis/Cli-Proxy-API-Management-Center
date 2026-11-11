/**
 * Pooled quota: the sum of every credential's long (weekly) window for one provider.
 *
 * Per-credential cards answer "how much is left on this account"; the pool answers
 * "how much is left across all of them, and when does it run out". Recorded values come
 * from the proxy's quota history (GET /observability/quota-history); the projection
 * follows the usage rhythm learned from that history (quiet nights, lighter weekends),
 * nudged by the recent burn rate, and spends it the way the soonest-reset router does —
 * always from the credential whose window resets first — refilling each at its reset.
 *
 * Pure functions only: `now` is always passed in.
 */

import { DAY_MS, HOUR_MS } from '@/utils/time/durations';

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
  /**
   * 5h windows: a window only starts when the credential is used, so a null reset means
   * idle and the reset comes one period after the next use.
   */
  startsOnUse?: boolean;
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
/** Resets that give back less than this are not worth a label (usage readings jitter by 1). */
const MIN_LABELLED_GAIN = 2;

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
  // Binary search: 30 days of history make a linear scan per event quadratic.
  let lo = 0;
  let hi = points.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (points[mid].t * 1000 <= t) lo = mid;
    else hi = mid - 1;
  }
  return remainingAt(points[lo], t);
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
  now: number,
  /** 5h windows: usage in a window that follows an expired one counts from zero. */
  fromZero = false
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
      else if (fromZero && prev && prev.reset <= point.t) consumed += current.used;
      prev = current;
    }
    if (prev && account.resetAtMs !== null && Math.round(account.resetAtMs / 1000) === prev.reset) {
      consumed += Math.max(0, 100 - account.remaining - prev.used);
    }
  }
  return windowHours > 0 ? consumed / windowHours : 0;
}

/**
 * Project the pool forward to `endMs`. `burn` is points per hour, either constant or a
 * function of time (see `projectedRate`). Usage is drawn from the credential that resets
 * soonest and still has quota, which is how soonest-reset routing spends it; each
 * credential refills to 100% at its reset and its next window starts.
 */
export function projectPool(
  accounts: PoolAccount[],
  burn: number | ((t: number) => number),
  now: number,
  endMs: number
): PoolProjection {
  // Points burned between two instants at most one step apart: the rate at the midpoint.
  const burned = (from: number, to: number) =>
    to <= from
      ? 0
      : Math.max(0, typeof burn === 'number' ? burn : burn((from + to) / 2)) *
        ((to - from) / HOUR_MS);
  const state = accounts.map((account) => ({
    name: account.displayName,
    remaining: account.remaining,
    nextReset: account.resetAtMs ?? Number.POSITIVE_INFINITY,
    periodMs: account.periodHours * HOUR_MS,
    startsOnUse: account.startsOnUse === true,
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
      const emptiedBefore = drain(state, burned(t, at), at);
      if (!firstEmpty && emptiedBefore) firstEmpty = { name: emptiedBefore, t: at };
      t = at;
      const before = total();
      due.remaining = 100;
      due.nextReset =
        !due.startsOnUse && Number.isFinite(due.periodMs) && due.periodMs > 0
          ? at + due.periodMs
          : Infinity;
      const after = total();
      series.push({ t: at, v: before });
      series.push({ t: at, v: after });
      if (after - before >= MIN_LABELLED_GAIN)
        resets.push({ t: at, gain: after - before, v: after });
    }

    const emptied = drain(state, burned(t, next), next);
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
  state: {
    name: string;
    remaining: number;
    nextReset: number;
    periodMs: number;
    startsOnUse: boolean;
  }[],
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
    // First use of an idle window starts it.
    if (take > 0 && account.startsOnUse && account.nextReset === Infinity) {
      account.nextReset = at + account.periodMs;
    }
    account.remaining -= take;
    left -= take;
    if (account.remaining <= 1e-9 && account.nextReset > at) {
      account.remaining = 0;
      emptied ??= account.name;
    }
  }
  return emptied;
}

/**
 * Reset labels that fit the chart: marks closer than `minGap` (a fraction of the view)
 * merge into one label at the latest mark, carrying their summed gain.
 */
export function mergeResetLabels(
  marks: PoolResetMark[],
  startMs: number,
  endMs: number,
  minGap = 0.05
): PoolResetMark[] {
  const gapMs = (endMs - startMs) * minGap;
  const merged: PoolResetMark[] = [];
  for (const mark of [...marks]
    .filter((candidate) => candidate.t >= startMs && candidate.t <= endMs)
    .sort((a, b) => a.t - b.t)) {
    const last = merged[merged.length - 1];
    if (last && mark.t - last.t < gapMs) {
      merged[merged.length - 1] = { t: mark.t, gain: last.gain + mark.gain, v: mark.v };
    } else {
      merged.push(mark);
    }
  }
  return merged;
}

/**
 * The usage rhythm learned from history: expected pool burn in points per hour for each
 * local hour of a weekday and of a weekend day.
 */
export interface UsageProfile {
  weekday: number[];
  weekend: number[];
  /** Points a typical week burns. */
  perWeek: number;
  /** Hours of history the rhythm was learned from. */
  observedHours: number;
}

/** Below this much history the rhythm is noise; the projection stays at the recent pace. */
const MIN_PROFILE_HOURS = 48;
/** The level follows how the pool has been used lately, not how it was used a month ago. */
const LEVEL_WINDOW_MS = 14 * DAY_MS;
/** How the recent burn is blended into the learned rhythm. */
export interface RateTuning {
  /** How fast "busier (or quieter) than usual right now" fades back to the learned rhythm. */
  recentHalfLifeMs: number;
  /** The same for the 5h window, where a busy day stays busy for longer. */
  shortRecentHalfLifeMs: number;
  /** The recent pace counts for at most this many times the usual pace. */
  maxRecentFactor: number;
  /** How long burn at a normally idle hour is assumed to carry on. */
  sessionHalfLifeMs: number;
  /** The 5h window: how long the current burn itself is assumed to carry on. */
  currentHalfLifeMs: number;
}

/**
 * Defaults, chosen with `scripts/poolBacktest.ts` on the recorded history (2026-11-11, 15 days):
 * the rhythm carries the projection and the recent pace only nudges it. Stronger or longer
 * nudges predicted worse. Re-run the backtest before changing these, and keep the menu bar
 * app's `QuotaModel.swift` on the same values.
 */
export const RATE_TUNING: RateTuning = {
  recentHalfLifeMs: 1.5 * HOUR_MS,
  shortRecentHalfLifeMs: 6 * HOUR_MS,
  maxRecentFactor: 2,
  sessionHalfLifeMs: 0.5 * HOUR_MS,
  currentHalfLifeMs: HOUR_MS,
};

const isWeekend = (d: Date) => d.getDay() === 0 || d.getDay() === 6;
/** Slot 0..23 is a weekday hour, 24..47 a weekend hour, in local time. */
const slotOf = (ms: number) => {
  const d = new Date(ms);
  return (isWeekend(d) ? 24 : 0) + d.getHours();
};

/**
 * Points one credential used, as [time, points] at the observation that revealed them.
 * Readings jitter by a point, so only a new high within a reset window counts.
 */
export function usageEvents(points: PoolHistoryPoint[], fromZero = false): [number, number][] {
  const events: [number, number][] = [];
  let reset: number | null = null;
  let high = 0;
  for (const point of points) {
    const used = point.long_used * 100;
    if (reset !== point.long_reset) {
      // 5h windows: one that follows an expired window starts from zero.
      if (fromZero && reset !== null && reset <= point.t && used > 0) {
        events.push([point.t * 1000, used]);
      }
      reset = point.long_reset;
      high = used;
      continue;
    }
    if (used > high) {
      events.push([point.t * 1000, used - high]);
      high = used;
    }
  }
  return events;
}

/** Hours each slot was covered between two instants (partial hours count partially). */
function slotExposure(fromMs: number, toMs: number): number[] {
  const hours = new Array<number>(48).fill(0);
  for (let t = fromMs; t < toMs; ) {
    const next = new Date(t);
    next.setMinutes(60, 0, 0);
    const end = Math.min(next.getTime(), toMs);
    hours[slotOf(t)] += (end - t) / HOUR_MS;
    t = end;
  }
  return hours;
}

/**
 * Learn when the pool gets used. The shape (which hours and day types are busy) comes
 * from every credential of the provider in `shapeHistory`, including ones no longer in
 * the pool, because a pool that changed last week has too little history of its own.
 * The level comes from the pool's current credentials only, over the time they all have
 * history, so the profile is in the pool's own points per hour.
 *
 * Time with no samples (the proxy was off, the Mac asleep) counts as observed and idle:
 * usage made elsewhere shows up on the next sample.
 */
export function learnUsageProfile(
  shapeHistory: PoolHistoryPoint[][],
  accounts: PoolAccount[],
  history: Map<string, PoolHistoryPoint[]>,
  now: number
): UsageProfile | null {
  const lists = shapeHistory.filter((points) => points.length > 0);
  if (lists.length === 0) return null;
  const firstMs = Math.min(...lists.map((points) => points[0].t * 1000));
  const observedHours = (now - firstMs) / HOUR_MS;
  if (observedHours < MIN_PROFILE_HOURS) return null;

  const exposure = slotExposure(firstMs, now);
  const used = new Array<number>(48).fill(0);
  for (const points of lists) {
    for (const [t, amount] of usageEvents(points)) if (t <= now) used[slotOf(t)] += amount;
  }
  // No weekend seen yet: assume it looks like a weekday until one has been recorded.
  const weekendSeen = exposure.slice(24).reduce((sum, hours) => sum + hours, 0) >= 24;
  // Smooth over neighbouring hours; a few weeks give each hour only a handful of samples.
  const shape = (offset: number) =>
    Array.from({ length: 24 }, (_, hour) => {
      let points = 0;
      let hours = 0;
      for (const [shift, weight] of [
        [-1, 1],
        [0, 2],
        [1, 1],
      ]) {
        const slot = offset + ((hour + shift + 24) % 24);
        points += weight * used[slot];
        hours += weight * exposure[slot];
      }
      return hours > 0 ? points / hours : 0;
    });
  const weekday = shape(0);
  const weekend = weekendSeen ? shape(24) : weekday;
  const shapeAt = (slot: number) => (slot < 24 ? weekday[slot] : weekend[slot - 24]);

  // Scale the shape so it reproduces what the current credentials actually burned.
  const tracked = accounts
    .map((account) => history.get(account.name) ?? [])
    .filter((points) => points.length > 0);
  let scale = 1;
  if (tracked.length > 0) {
    const fromMs = Math.max(
      now - LEVEL_WINDOW_MS,
      ...tracked.map((points) => points[0].t * 1000)
    );
    if (now - fromMs >= 24 * HOUR_MS) {
      const expected = slotExposure(fromMs, now).reduce(
        (sum, hours, slot) => sum + hours * shapeAt(slot),
        0
      );
      const actual = tracked
        .flatMap((points) => usageEvents(points))
        .reduce((sum, [t, amount]) => (t > fromMs && t <= now ? sum + amount : sum), 0);
      if (expected > 0) scale = actual / expected;
    }
  }
  const scaled = (rates: number[]) => rates.map((rate) => rate * scale);
  const profile = { weekday: scaled(weekday), weekend: scaled(weekend) };
  const perDay = (rates: number[]) => rates.reduce((sum, rate) => sum + rate, 0);
  const perWeek = 5 * perDay(profile.weekday) + 2 * perDay(profile.weekend);
  return perWeek > 0 ? { ...profile, perWeek, observedHours } : null;
}

/** The learned burn in points per hour at `t`. */
export function profileRate(profile: UsageProfile, t: number): number {
  const slot = slotOf(t);
  return slot < 24 ? profile.weekday[slot] : profile.weekend[slot - 24];
}

/**
 * Burn rate to project with: the learned rhythm, scaled by how much busier or quieter than
 * usual the last `recentHours` were. That factor fades back to 1 over a few hours, and it
 * multiplies the rhythm, so a busy evening does not turn into a busy night. Burn the
 * rhythm cannot explain at all (working at an hour that is normally idle) carries on
 * briefly on its own. Without a profile it is the constant recent rate.
 */
export function projectedRate(
  profile: UsageProfile | null,
  recentBurn: number,
  recentHours: number,
  now: number,
  tuning: RateTuning = RATE_TUNING
): (t: number) => number {
  if (!profile) return () => recentBurn;
  const samples = Math.max(1, Math.round(recentHours * 4));
  let usual = 0;
  for (let i = 0; i < samples; i++) {
    usual += profileRate(profile, now - ((i + 0.5) / samples) * recentHours * HOUR_MS);
  }
  usual /= samples;
  const factor = usual > 0 ? Math.min(tuning.maxRecentFactor, recentBurn / usual) : 1;
  const unexplained = Math.max(0, recentBurn - factor * usual);
  return (t) => {
    const elapsed = Math.max(0, t - now);
    return (
      profileRate(profile, t) * (1 + (factor - 1) * 0.5 ** (elapsed / tuning.recentHalfLifeMs)) +
      unexplained * 0.5 ** (elapsed / tuning.sessionHalfLifeMs)
    );
  };
}

export const SHORT_PERIOD_HOURS = 5;

/**
 * The 5h window as pool history: the same points with usage and reset taken from the short
 * window, so the pool functions above work on it. A point without a short reset is an idle
 * window: full, and its reset 0 never comes.
 */
export function shortWindowHistory(
  history: Map<string, PoolHistoryPoint[]>
): Map<string, PoolHistoryPoint[]> {
  const out = new Map<string, PoolHistoryPoint[]>();
  for (const [name, points] of history) {
    out.set(
      name,
      points.map((point) => ({
        ...point,
        long_used: point.short_reset ? (point.short_used ?? 0) : 0,
        long_reset: point.short_reset ?? 0,
      }))
    );
  }
  return out;
}

/**
 * Current 5h state of a credential from its newest point in `shortWindowHistory`. An expired
 * or idle window is full and has no reset: the next one only starts on first use.
 */
export function shortAccountFromHistory(
  name: string,
  displayName: string,
  points: PoolHistoryPoint[] | undefined,
  now: number
): PoolAccount | null {
  const latest = points?.[points.length - 1];
  if (!latest) return null;
  const running = latest.long_reset * 1000 > now;
  return {
    name,
    displayName,
    remaining: running ? clamp(100 - latest.long_used * 100) : 100,
    resetAtMs: running ? latest.long_reset * 1000 : null,
    periodHours: SHORT_PERIOD_HOURS,
    startsOnUse: true,
  };
}

/**
 * How many 5h-window points one weekly point costs, from what the pool's credentials burned
 * in both windows lately. It turns the weekly rhythm into 5h points.
 */
export function shortPerLongPoint(
  accounts: PoolAccount[],
  history: Map<string, PoolHistoryPoint[]>,
  shortHistory: Map<string, PoolHistoryPoint[]>,
  now: number
): number | null {
  const total = (source: Map<string, PoolHistoryPoint[]>, fromZero: boolean) =>
    accounts
      .flatMap((account) => usageEvents(source.get(account.name) ?? [], fromZero))
      .reduce((sum, [t, amount]) => (t > now - LEVEL_WINDOW_MS && t <= now ? sum + amount : sum), 0);
  const long = total(history, false);
  const short = total(shortHistory, true);
  // A handful of weekly points is too coarse to divide by.
  return long >= 5 && short > 0 ? short / long : null;
}

/**
 * Burn for the 5h window, in its own points per hour. It starts at the current burn and keeps
 * a share of it that halves every hour; the rest follows the rhythm (`scale` × profile),
 * scaled by how today compares with the usual and fading like the weekly one. So it reacts
 * to what is happening now, yet winds down towards the night and picks up before a working
 * morning. Without a profile or scale it is the constant recent rate.
 */
export function reactiveRate(
  profile: UsageProfile | null,
  scale: number | null,
  recentBurn: number,
  recentHours: number,
  now: number,
  tuning: RateTuning = RATE_TUNING
): (t: number) => number {
  if (!profile || scale === null) return () => recentBurn;
  const samples = Math.max(1, Math.round(recentHours * 4));
  let usual = 0;
  for (let i = 0; i < samples; i++) {
    usual += scale * profileRate(profile, now - ((i + 0.5) / samples) * recentHours * HOUR_MS);
  }
  usual /= samples;
  const factor = usual > 0 ? Math.min(tuning.maxRecentFactor, recentBurn / usual) : 1;
  return (t) => {
    const elapsed = Math.max(0, t - now);
    const current = 0.5 ** (elapsed / tuning.currentHalfLifeMs);
    const rhythm =
      scale *
      profileRate(profile, t) *
      (1 + (factor - 1) * 0.5 ** (elapsed / tuning.shortRecentHalfLifeMs));
    return current * recentBurn + (1 - current) * rhythm;
  };
}

export interface PoolSpan {
  id: string;
  label: string;
  spanMs: number;
}

/** How much recorded history the chart shows before now. */
export const POOL_VIEWS: PoolSpan[] = [
  { id: '1d', label: '1d', spanMs: DAY_MS },
  { id: '3d', label: '3d', spanMs: 3 * DAY_MS },
  { id: '7d', label: '7d', spanMs: 7 * DAY_MS },
  { id: '14d', label: '14d', spanMs: 14 * DAY_MS },
  { id: '30d', label: '30d', spanMs: 30 * DAY_MS },
];

/** How much projection the chart shows after now. */
export const POOL_AHEAD: PoolSpan[] = [
  { id: '0', label: 'Off', spanMs: 0 },
  { id: '1d', label: '1d', spanMs: DAY_MS },
  { id: '3d', label: '3d', spanMs: 3 * DAY_MS },
  { id: '7d', label: '7d', spanMs: 7 * DAY_MS },
  { id: '14d', label: '14d', spanMs: 14 * DAY_MS },
];

export interface PoolScale {
  /** Gridline spacing. */
  tickMs: number;
  /** Every n-th gridline gets a label. */
  labelEvery: number;
}

/** Gridlines that suit a chart `spanMs` wide. */
export function viewScale(spanMs: number): PoolScale {
  if (spanMs <= 1.5 * DAY_MS) return { tickMs: 3 * HOUR_MS, labelEvery: 1 };
  if (spanMs <= 4 * DAY_MS) return { tickMs: 6 * HOUR_MS, labelEvery: 2 };
  if (spanMs <= 15 * DAY_MS) return { tickMs: DAY_MS, labelEvery: 1 };
  if (spanMs <= 22 * DAY_MS) return { tickMs: DAY_MS, labelEvery: 2 };
  return { tickMs: DAY_MS, labelEvery: Math.ceil(spanMs / (10 * DAY_MS)) };
}

/** Snap `ms` down to a local tick boundary: midnight for day ticks, else whole tick hours. */
function snapToTick(scale: PoolScale, ms: number): Date {
  const d = new Date(ms);
  if (scale.tickMs >= DAY_MS) {
    d.setHours(0, 0, 0, 0);
  } else {
    const stepHours = scale.tickMs / HOUR_MS;
    d.setMinutes(0, 0, 0);
    d.setHours(Math.floor(d.getHours() / stepHours) * stepHours);
  }
  return d;
}

/** Gridline instants in [startMs, endMs), aligned to local tick boundaries. */
export function viewTicks(scale: PoolScale, startMs: number, endMs: number): number[] {
  const ticks: number[] = [];
  // Step by calendar days/hours so DST shifts don't drift the gridlines off midnight.
  for (let d = snapToTick(scale, startMs); d.getTime() < endMs; ) {
    if (d.getTime() >= startMs) ticks.push(d.getTime());
    d = new Date(d);
    if (scale.tickMs >= DAY_MS) d.setDate(d.getDate() + scale.tickMs / DAY_MS);
    else d.setHours(d.getHours() + scale.tickMs / HOUR_MS);
  }
  return ticks;
}

/**
 * Scores the pool projections against the recorded quota history.
 *
 *   bun scripts/poolBacktest.ts [path to quota-history.jsonl] [--grid] [--since 2026-11-08]
 *
 * At every hour in the history it predicts, from the points known at that moment, how many
 * points the pool will burn over the next hours, and compares that with what was recorded.
 * It prints the mean absolute error and the bias (prediction minus actual) for the constant
 * pace the charts used before and for the learned rhythm; `--grid` also tries other tunings.
 * Re-run it when there is more history before changing RATE_TUNING.
 */

import { readFileSync } from 'fs';
import { homedir } from 'os';
import {
  burnRatePerHour,
  historyByAccount,
  learnUsageProfile,
  profileRate,
  projectedRate,
  RATE_TUNING,
  reactiveRate,
  shortPerLongPoint,
  shortWindowHistory,
  usageEvents,
} from '../src/features/quota/quotaPoolModel';
import type {
  PoolAccount,
  PoolHistoryPoint,
  RateTuning,
} from '../src/features/quota/quotaPoolModel';

const HOUR = 3_600_000;
const args = process.argv.slice(2);
const grid = args.includes('--grid');
/** `--since 2026-11-08`: only score moments from this date on (history before it still teaches). */
const sinceArg = args.indexOf('--since');
const sinceMs = sinceArg >= 0 ? new Date(args[sinceArg + 1]).getTime() : 0;
const path =
  args.find((arg, i) => !arg.startsWith('--') && i !== sinceArg + 1) ?? `${homedir()}/.cli-proxy-api/quota-history.jsonl`;
const provider = 'claude';

const points: PoolHistoryPoint[] = readFileSync(path, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line) as PoolHistoryPoint)
  .filter((point) => point.provider === provider);
const history = historyByAccount(points);
const shortHistory = shortWindowHistory(history);
const firstMs = Math.min(...points.map((point) => point.t)) * 1000;
const lastMs = Math.max(...points.map((point) => point.t)) * 1000;

/** The points of every credential up to `t`. */
function upTo(source: Map<string, PoolHistoryPoint[]>, t: number) {
  const out = new Map<string, PoolHistoryPoint[]>();
  for (const [name, list] of source) {
    let hi = list.length;
    let lo = 0;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid].t * 1000 <= t) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) out.set(name, list.slice(0, lo));
  }
  return out;
}

/** Credentials sampled around `t` and still sampled at `until`: the pool did not change. */
function poolAt(t: number, until: number): string[] {
  return [...history.entries()]
    .filter(([, list]) => {
      const seen = (from: number, to: number) =>
        list.some((point) => point.t * 1000 > from && point.t * 1000 <= to);
      return seen(t - 6 * HOUR, t) && seen(until - 6 * HOUR, until + 6 * HOUR);
    })
    .map(([name]) => name);
}

const events = new Map<string, { long: [number, number][]; short: [number, number][] }>();
for (const [name, list] of history) {
  events.set(name, {
    long: usageEvents(list),
    short: usageEvents(shortHistory.get(name) ?? [], true),
  });
}
const actual = (names: string[], kind: 'long' | 'short', from: number, to: number) =>
  names
    .flatMap((name) => events.get(name)?.[kind] ?? [])
    .reduce((sum, [t, amount]) => (t > from && t <= to ? sum + amount : sum), 0);

const integrate = (rate: (t: number) => number, from: number, to: number) => {
  let total = 0;
  const step = 10 * 60 * 1000;
  for (let t = from; t < to; t += step) {
    const next = Math.min(t + step, to);
    total += Math.max(0, rate((t + next) / 2)) * ((next - t) / HOUR);
  }
  return total;
};

class Score {
  private abs = 0;
  private bias = 0;
  private n = 0;
  add(predicted: number, real: number) {
    this.abs += Math.abs(predicted - real);
    this.bias += predicted - real;
    this.n += 1;
  }
  get mae() {
    return this.n > 0 ? this.abs / this.n : NaN;
  }
  toString() {
    return this.n === 0
      ? 'no data'
      : `error ${this.mae.toFixed(2).padStart(6)}  bias ${(this.bias / this.n).toFixed(2).padStart(6)}`;
  }
}

interface Method {
  name: string;
  window: 'long' | 'short';
  predict: (ctx: Context, horizonMs: number) => number | null;
}
interface Context {
  t: number;
  accounts: PoolAccount[];
  known: Map<string, PoolHistoryPoint[]>;
  knownShort: Map<string, PoolHistoryPoint[]>;
  profile: ReturnType<typeof learnUsageProfile>;
  scale: number | null;
}

const longRhythm =
  (hours: number, tuning: RateTuning) =>
  ({ t, accounts, known, profile }: Context, horizonMs: number) =>
    profile
      ? integrate(
          projectedRate(profile, burnRatePerHour(accounts, known, hours, t), hours, t, tuning),
          t,
          t + horizonMs
        )
      : null;
const shortRhythm =
  (tuning: RateTuning) =>
  ({ t, accounts, knownShort, profile, scale }: Context, horizonMs: number) =>
    profile && scale !== null
      ? integrate(
          reactiveRate(
            profile,
            scale,
            burnRatePerHour(accounts, knownShort, 1, t, true),
            1,
            t,
            tuning
          ),
          t,
          t + horizonMs
        )
      : null;
const constant =
  (hours: number, window: 'long' | 'short') =>
  ({ t, accounts, known, knownShort }: Context, horizonMs: number) =>
    burnRatePerHour(accounts, window === 'long' ? known : knownShort, hours, t, window === 'short') *
    (horizonMs / HOUR);

const methods: Method[] = [
  { name: 'weekly  constant, last 3h (old panel)', window: 'long', predict: constant(3, 'long') },
  { name: 'weekly  constant, last 24h (old menu bar)', window: 'long', predict: constant(24, 'long') },
  {
    name: 'weekly  rhythm only',
    window: 'long',
    predict: ({ t, profile }, horizonMs) =>
      profile ? integrate((at) => profileRate(profile, at), t, t + horizonMs) : null,
  },
  { name: 'weekly  rhythm + last 3h (panel)', window: 'long', predict: longRhythm(3, RATE_TUNING) },
  { name: 'weekly  rhythm + last 5h (menu bar)', window: 'long', predict: longRhythm(5, RATE_TUNING) },
  { name: '5h      constant, last 1h (old)', window: 'short', predict: constant(1, 'short') },
  {
    name: '5h      rhythm only',
    window: 'short',
    predict: ({ t, profile, scale }, horizonMs) =>
      profile && scale !== null
        ? integrate((at) => scale * profileRate(profile, at), t, t + horizonMs)
        : null,
  },
  { name: '5h      rhythm led by last 1h', window: 'short', predict: shortRhythm(RATE_TUNING) },
];
if (grid) {
  for (const recent of [0.75, 1.5, 3, 6]) {
    for (const max of [1.5, 2, 4]) {
      for (const session of [0.25, 0.5, 1]) {
        const tuning = {
          ...RATE_TUNING,
          recentHalfLifeMs: recent * HOUR,
          maxRecentFactor: max,
          sessionHalfLifeMs: session * HOUR,
        };
        methods.push({
          name: `weekly  grid recent ${recent}h max ${max}× session ${session}h`,
          window: 'long',
          predict: longRhythm(3, tuning),
        });
      }
    }
  }
  for (const current of [0.5, 1, 1.5, 3]) {
    for (const recent of [3, 6, 12]) {
      for (const max of [1.5, 2, 4]) {
        const tuning = {
          ...RATE_TUNING,
          currentHalfLifeMs: current * HOUR,
          shortRecentHalfLifeMs: recent * HOUR,
          maxRecentFactor: max,
        };
        methods.push({
          name: `5h      grid current ${current}h recent ${recent}h max ${max}×`,
          window: 'short',
          predict: shortRhythm(tuning),
        });
      }
    }
  }
}

const HORIZONS = { long: [6, 24, 72], short: [1, 3, 5] };
const scores = new Map<string, Score[]>(methods.map((method) => [method.name, [0, 1, 2].map(() => new Score())]));
/** Only moments where every method has a prediction are scored, so the rows are comparable. */
let moments = 0;
for (let t = Math.max(firstMs + 72 * HOUR, sinceMs); t <= lastMs; t += HOUR) {
  const known = upTo(history, t);
  const knownShort = upTo(shortHistory, t);
  for (const window of ['long', 'short'] as const) {
    HORIZONS[window].forEach((hours, i) => {
      const until = t + hours * HOUR;
      if (until > lastMs) return;
      const names = poolAt(t, until);
      if (names.length === 0) return;
      const accounts: PoolAccount[] = names.map((name) => ({
        name,
        displayName: name,
        remaining: 0,
        resetAtMs: null,
        periodHours: 168,
      }));
      const profile = learnUsageProfile([...known.values()], accounts, known, t);
      const ctx: Context = {
        t,
        accounts,
        known,
        knownShort,
        profile,
        scale: shortPerLongPoint(accounts, known, knownShort, t),
      };
      const mine = methods.filter((method) => method.window === window);
      const predictions = mine.map((method) => method.predict(ctx, hours * HOUR));
      if (predictions.some((value) => value === null)) return;
      const real = actual(names, window, t, until);
      mine.forEach((method, m) => scores.get(method.name)![i].add(predictions[m]!, real));
      if (window === 'long' && i === 0) moments += 1;
    });
  }
}

const days = ((lastMs - firstMs) / (24 * HOUR)).toFixed(1);
console.log(`${path}: ${points.length} ${provider} points over ${days} days, ${moments} moments scored`);
console.log('Mean absolute error and bias (prediction minus actual), in pool points burned.\n');
for (const window of ['long', 'short'] as const) {
  const rows = methods.filter((method) => method.window === window);
  const fixed = rows.filter((method) => !method.name.includes(' grid '));
  // Of the grid, show the best few by the middle horizon.
  const best = rows
    .filter((method) => method.name.includes(' grid '))
    .sort((a, b) => scores.get(a.name)![1].mae - scores.get(b.name)![1].mae)
    .slice(0, 5);
  console.log(
    ''.padEnd(58) + HORIZONS[window].map((hours) => `next ${hours}h`.padEnd(30)).join('')
  );
  for (const method of [...fixed, ...best]) {
    console.log(
      method.name.padEnd(58) +
        scores
          .get(method.name)!
          .map((score) => score.toString().padEnd(30))
          .join('')
    );
  }
  console.log('');
}

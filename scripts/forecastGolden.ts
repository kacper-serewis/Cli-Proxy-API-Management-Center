/**
 * The golden forecast: one quota history with the forecast the panel computes from it,
 * which the menu bar app (tools/cliproxybar in the proxy fork) must reproduce. The same
 * file is checked into both repos and both test suites compare against it, so the two
 * implementations cannot drift apart unnoticed.
 *
 *   TZ=UTC bun scripts/forecastGolden.ts --synthetic > tests/fixtures/forecast-golden.json
 *   cp tests/fixtures/forecast-golden.json \
 *     ~/dev/cliproxyapi-fork/tools/cliproxybar/Tests/CliproxyBarCoreTests/Fixtures/
 *
 * To compare both on the live history (local time zone), write a file and point the menu
 * bar test at it:
 *
 *   bun scripts/forecastGolden.ts --history ~/.cli-proxy-api/quota-history.jsonl \
 *     --names <auth file>,<auth file> > /tmp/forecast-live.json
 *   CPB_GOLDEN=/tmp/forecast-live.json swift test --filter forecastMatchesThePanel
 */

import { readFileSync } from 'node:fs';
import {
  EVENTS_AHEAD_MS,
  RECENT_PACE_HOURS,
  SHORT_BURN_HOURS,
  forecastJointPool,
  headroomEvents,
} from '../src/features/quota/jointQuotaProjection';
import {
  accountFromHistory,
  burnRatePerHour,
  historyByAccount,
  learnUsageProfile,
  projectedRate,
  reactiveRate,
  shortAccountFromHistory,
  shortPerLongPoint,
  shortWindowHistory,
} from '../src/features/quota/quotaPoolModel';
import type { PoolAccount, PoolHistoryPoint } from '../src/features/quota/quotaPoolModel';

const HOUR = 3_600_000;

export interface GoldenInput {
  /** Unix milliseconds. */
  now: number;
  /** IANA zone the usage rhythm's hours and the working hours are read in. */
  timeZone: string;
  /** The pool's credentials. */
  names: string[];
  points: PoolHistoryPoint[];
}

export interface GoldenForecast {
  /** The learned rhythm in points per hour by local hour; null without enough history. */
  weekday: number[] | null;
  weekend: number[] | null;
  /** Weekly burn over the last RECENT_PACE_HOURS and 5h burn over the last hour. */
  recentBurn: number;
  shortBurn: number;
  shortPerLong: number | null;
  /** The projected weekly and 5h burn every two hours from now, for a week. */
  longRate: number[];
  shortRate: number[];
  /** Per account, in `names` order: weekly and 5h points used at the start. */
  longUsed: number[];
  shortUsed: number[];
  /** The periods without safe headroom in the coming week: [start, end, working ms]. */
  events: [number, number, number][];
}

/** The forecast the panel computes from a history, with the steps that lead to it. */
export function goldenForecast(input: GoldenInput): GoldenForecast {
  const { now, names, points } = input;
  const history = historyByAccount(points);
  const shortHistory = shortWindowHistory(history);
  const accounts = names.map(
    (name) => accountFromHistory(name, name, history.get(name), now) as PoolAccount
  );
  const shortAccounts = names.map(
    (name) => shortAccountFromHistory(name, name, shortHistory.get(name), now) as PoolAccount
  );
  const provider = history.get(names[0])?.[0]?.provider;
  const shape = [...history.values()].filter((list) => list[0].provider === provider);
  const profile = learnUsageProfile(shape, accounts, history, now);
  const recentBurn = burnRatePerHour(accounts, history, RECENT_PACE_HOURS, now);
  const shortBurn = burnRatePerHour(shortAccounts, shortHistory, SHORT_BURN_HOURS, now, true);
  const shortPerLong = shortPerLongPoint(accounts, history, shortHistory, now);
  const end = now + 2 * EVENTS_AHEAD_MS;
  const joint = forecastJointPool({
    accounts,
    shortAccounts,
    history,
    shortHistory,
    profile,
    now,
    end,
  });
  const longRate = projectedRate(profile, recentBurn, RECENT_PACE_HOURS, now);
  const shortRate = reactiveRate(profile, shortPerLong, shortBurn, SHORT_BURN_HOURS, now);
  const samples = Array.from({ length: 85 }, (_, i) => now + i * 2 * HOUR);
  return {
    weekday: profile?.weekday ?? null,
    weekend: profile?.weekend ?? null,
    recentBurn,
    shortBurn,
    shortPerLong,
    longRate: samples.map(longRate),
    shortRate: samples.map(shortRate),
    longUsed: accounts.map((account) => 100 - account.remaining),
    shortUsed: shortAccounts.map((account) => 100 - account.remaining),
    events: headroomEvents(joint.gaps, now, now + EVENTS_AHEAD_MS, end).map((event) => [
      event.start,
      event.end,
      event.workingMs,
    ]),
  };
}

/**
 * Three weeks of made-up history for two seats and one retired account: busy weekday
 * hours, quiet nights and weekends, staggered weekly resets, 5h windows that start on
 * use, readings only when something changed, and now and then a reset reported a second
 * off. It ends tight enough for the forecast to find gaps.
 */
function syntheticInput(): GoldenInput {
  let seed = 20261118;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  const STEP = 10 * 60 * 1000;
  const WEEK = 168 * HOUR;
  const now = Date.UTC(2026, 10, 18, 10, 40); // a Wednesday
  const start = now - 21 * 24 * HOUR;
  const seats = [
    { name: 'claude-seat-a.json', long: 12, longReset: start + 30 * HOUR, short: 0, shortReset: 0 },
    { name: 'claude-seat-b.json', long: 40, longReset: start + 100 * HOUR, short: 0, shortReset: 0 },
  ];
  const retired = { name: 'claude-retired.json', long: 5, longReset: start + 60 * HOUR };
  const points: PoolHistoryPoint[] = [];
  const last = new Map<string, string>();
  const record = (
    t: number,
    name: string,
    long: number,
    longReset: number,
    short?: number,
    shortReset?: number
  ) => {
    const jitter = random() < 0.05 ? -1 : 0;
    const point: PoolHistoryPoint = {
      t: Math.round(t / 1000),
      auth: name,
      provider: 'claude',
      long_used: Math.round(long) / 100,
      long_reset: Math.round(longReset / 1000) + jitter,
      ...(shortReset ? { short_used: Math.round(short ?? 0) / 100, short_reset: Math.round(shortReset / 1000) } : {}),
    };
    const key = `${point.long_used}|${Math.round(longReset / 1000)}|${point.short_used}|${point.short_reset}`;
    // Like the proxy: a point when the reading changed, and one an hour regardless.
    if (last.get(name) === key && (t - start) % HOUR !== 0) return;
    last.set(name, key);
    points.push(point);
  };
  for (let t = start; t <= now; t += STEP) {
    const date = new Date(t);
    const day = date.getUTCDay();
    const hour = date.getUTCHours();
    const weekend = day === 0 || day === 6;
    const busy = hour >= 8 && hour < 18 ? 3.2 : hour >= 20 && hour < 23 ? 1.4 : 0.05;
    const demand = (weekend ? 0.3 : 1) * busy * (0.4 + 1.2 * random()) * (STEP / HOUR);
    for (const seat of seats) {
      if (t >= seat.longReset) {
        seat.long = 0;
        seat.longReset += WEEK;
      }
      if (seat.shortReset && t >= seat.shortReset) {
        seat.short = 0;
        seat.shortReset = 0;
      }
    }
    // Soonest reset first, while it has room in both windows.
    const open = seats
      .filter((seat) => seat.long < 99 && seat.short < 90)
      .sort((a, b) => a.longReset - b.longReset)[0];
    if (open && demand > 0) {
      open.long = Math.min(100, open.long + demand);
      if (!open.shortReset) open.shortReset = t + 5 * HOUR;
      open.short = Math.min(100, open.short + demand * 6);
    }
    for (const seat of seats) {
      record(t, seat.name, seat.long, seat.longReset, seat.short, seat.shortReset);
    }
    // The retired account was only used in the first week: it shapes the rhythm, not the level.
    if (t < start + 7 * 24 * HOUR) {
      if (t >= retired.longReset) {
        retired.long = 0;
        retired.longReset += WEEK;
      }
      retired.long = Math.min(100, retired.long + demand * 0.5);
      record(t, retired.name, retired.long, retired.longReset);
    }
  }
  return { now, timeZone: 'UTC', names: seats.map((seat) => seat.name), points };
}

function liveInput(path: string, names: string[]): GoldenInput {
  const points = readFileSync(path.replace(/^~/, process.env.HOME ?? '~'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as PoolHistoryPoint)
    .filter((point) => point.provider === 'claude');
  const now = Math.max(...points.map((point) => point.t)) * 1000 + 60_000;
  return { now, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, names, points };
}

if (import.meta.main) {
  const arg = (name: string) => {
    const index = process.argv.indexOf(name);
    return index < 0 ? undefined : process.argv[index + 1];
  };
  const history = arg('--history');
  if (!history && !process.argv.includes('--synthetic')) {
    console.error('usage: forecastGolden.ts --synthetic | --history <jsonl> --names <a,b>');
    process.exit(2);
  }
  const input = history ? liveInput(history, (arg('--names') ?? '').split(',')) : syntheticInput();
  if (input.timeZone !== Intl.DateTimeFormat().resolvedOptions().timeZone) {
    console.error(`run with TZ=${input.timeZone}: the rhythm is learned in local hours`);
    process.exit(2);
  }
  // Points as rows keep the file small: [t, account, long_used, long_reset, short_used, short_reset].
  const accounts = [...new Set(input.points.map((point) => point.auth))];
  const rows = input.points.map((point) => [
    point.t,
    accounts.indexOf(point.auth),
    point.long_used,
    point.long_reset,
    point.short_used ?? null,
    point.short_reset ?? null,
  ]);
  const lines = rows.map((row) => JSON.stringify(row)).join(',\n');
  console.log(
    `{\n"about": "Generated by scripts/forecastGolden.ts in the panel repo. Do not edit; the same file lives in the proxy fork under tools/cliproxybar/Tests/CliproxyBarCoreTests/Fixtures.",\n` +
      `"now": ${input.now},\n"timeZone": ${JSON.stringify(input.timeZone)},\n` +
      `"names": ${JSON.stringify(input.names)},\n"accounts": ${JSON.stringify(accounts)},\n` +
      `"expected": ${JSON.stringify(goldenForecast(input))},\n"points": [\n${lines}\n]\n}`
  );
}

/** The fixture file's shape, shared with the test that reads it back. */
export interface GoldenFile {
  now: number;
  timeZone: string;
  names: string[];
  accounts: string[];
  expected: GoldenForecast;
  points: [number, number, number, number, number | null, number | null][];
}

export function goldenInput(file: GoldenFile): GoldenInput {
  return {
    now: file.now,
    timeZone: file.timeZone,
    names: file.names,
    points: file.points.map(([t, account, long_used, long_reset, short_used, short_reset]) => ({
      t,
      auth: file.accounts[account],
      provider: 'claude',
      long_used,
      long_reset,
      ...(short_reset === null ? {} : { short_used: short_used ?? 0, short_reset }),
    })),
  };
}

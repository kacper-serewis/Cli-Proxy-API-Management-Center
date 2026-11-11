import { describe, expect, test } from 'bun:test';
import {
  accountFromHistory,
  burnRatePerHour,
  historyByAccount,
  mergeResetLabels,
  learnUsageProfile,
  profileRate,
  projectedRate,
  projectPool,
  recordedSeries,
  viewScale,
  viewTicks,
} from '../src/features/quota/quotaPoolModel';
import type { PoolAccount, PoolHistoryPoint } from '../src/features/quota/quotaPoolModel';

const HOUR = 3_600_000;
const now = Date.UTC(2026, 9, 27, 12, 0, 0);
const sec = (ms: number) => Math.floor(ms / 1000);

const account = (name: string, remaining: number, resetInHours: number): PoolAccount => ({
  name,
  displayName: name,
  remaining,
  resetAtMs: now + resetInHours * HOUR,
  periodHours: 168,
});

const point = (
  auth: string,
  hoursAgo: number,
  used: number,
  resetAtMs: number
): PoolHistoryPoint => ({
  t: sec(now - hoursAgo * HOUR),
  auth,
  provider: 'claude',
  long_used: used,
  long_reset: sec(resetAtMs),
});

describe('burnRatePerHour', () => {
  test('sums usage increases within the window, ignoring resets', () => {
    const resetA = now + 10 * HOUR;
    const history = historyByAccount([
      point('a', 5, 0.1, resetA), // before the 3h window: baseline
      point('a', 2, 0.2, resetA),
      point('a', 1, 0.25, resetA),
      // b reset inside the window: usage dropped, which is not negative burn
      point('b', 2, 0.9, now - HOUR),
      point('b', 0.5, 0.05, now + 100 * HOUR),
    ]);
    const accounts = [account('a', 70, 10), account('b', 95, 100)];
    // a: 10 → 20 → 25 → live 30 = 20 points. b only changed across its reset, so 0.
    expect(burnRatePerHour(accounts, history, 3, now)).toBeCloseTo(20 / 3, 5);
  });

  test('is zero without history', () => {
    expect(burnRatePerHour([account('a', 50, 10)], new Map(), 3, now)).toBe(0);
  });
});

describe('projectPool', () => {
  test('drains the soonest-reset account first and refills it at reset', () => {
    const accounts = [account('late', 100, 100), account('soon', 20, 30)];
    const projection = projectPool(accounts, 1, now, now + 50 * HOUR);
    // 'soon' has 20 points at 1/h, so it empties after 20h, before its 30h reset.
    expect(projection.firstEmpty?.name).toBe('soon');
    expect(projection.firstEmpty!.t - now).toBeLessThanOrEqual(20 * HOUR + 10 * 60 * 1000);
    expect(projection.firstEmpty!.t - now).toBeGreaterThanOrEqual(20 * HOUR);
    // Its reset at 30h gives back the full 100.
    expect(projection.resets[0]).toMatchObject({ t: now + 30 * HOUR, gain: 100 });
    expect(projection.poolEmptyAt).toBeNull();
    // 120 start − 50 burned + 100 reset
    expect(projection.series.at(-1)!.v).toBeCloseTo(170, 5);
  });

  test('reports when the whole pool runs out', () => {
    const projection = projectPool([account('a', 10, 200)], 2, now, now + 24 * HOUR);
    expect(projection.poolEmptyAt).not.toBeNull();
    expect(projection.poolEmptyAt! - now).toBeLessThanOrEqual(5 * HOUR + 10 * 60 * 1000);
  });

  test('without burn the line only steps up at resets', () => {
    const projection = projectPool([account('a', 40, 5)], 0, now, now + 24 * HOUR);
    expect(projection.resets).toHaveLength(1);
    expect(projection.resets[0].gain).toBeCloseTo(60, 5);
    expect(projection.firstEmpty).toBeNull();
  });
});

describe('recordedSeries', () => {
  test('applies recorded resets and ends on live values', () => {
    const history = historyByAccount([
      point('a', 20, 0.8, now - 10 * HOUR),
      point('b', 20, 0.5, now + 50 * HOUR),
    ]);
    const accounts = [account('a', 95, 158), account('b', 45, 50)];
    const { series, resets } = recordedSeries(accounts, history, now - 24 * HOUR, now);
    // Before the first point values carry backwards: 20 + 50.
    expect(series[0].v).toBeCloseTo(70, 5);
    // a resets 10h ago: +80.
    expect(resets).toHaveLength(1);
    expect(resets[0].gain).toBeCloseTo(80, 5);
    expect(series.at(-1)!.v).toBeCloseTo(140, 5);
  });
});

describe('accountFromHistory', () => {
  test('a passed reset means a full window and the next reset a period later', () => {
    const passed = accountFromHistory('a', 'a', [point('a', 30, 0.6, now - 2 * HOUR)], now);
    expect(passed?.remaining).toBe(100);
    expect(passed?.resetAtMs).toBe(sec(now - 2 * HOUR) * 1000 + 168 * HOUR);
    const pending = accountFromHistory('a', 'a', [point('a', 1, 0.6, now + 2 * HOUR)], now);
    expect(pending?.remaining).toBeCloseTo(40, 5);
  });
});

describe('mergeResetLabels', () => {
  test('merges marks closer than the gap and drops ones outside the view', () => {
    const start = now;
    const end = now + 100 * HOUR; // 5% gap = 5h
    const labels = mergeResetLabels(
      [
        { t: now + 10 * HOUR, gain: 43, v: 150 },
        { t: now + 12 * HOUR, gain: 3, v: 153 },
        { t: now + 14 * HOUR, gain: 2, v: 155 },
        { t: now + 40 * HOUR, gain: 100, v: 200 },
        { t: now + 120 * HOUR, gain: 100, v: 200 },
      ],
      start,
      end
    );
    expect(labels).toEqual([
      { t: now + 14 * HOUR, gain: 48, v: 155 },
      { t: now + 40 * HOUR, gain: 100, v: 200 },
    ]);
  });
});

describe('views', () => {
  const DAY = 24 * HOUR;

  test('day scales grid on local midnight', () => {
    const scale = viewScale(14 * DAY);
    const ticks = viewTicks(scale, now - 7 * DAY, now + 7 * DAY);
    expect(ticks).toHaveLength(14);
    expect(ticks.every((tick) => new Date(tick).getHours() === 0)).toBe(true);
  });

  test('hour scales grid on whole tick hours', () => {
    const scale = viewScale(DAY);
    const ticks = viewTicks(scale, now - DAY, now);
    expect(ticks).toHaveLength(8);
    expect(ticks.every((tick) => new Date(tick).getHours() % 3 === 0)).toBe(true);
    expect(ticks.every((tick) => new Date(tick).getMinutes() === 0)).toBe(true);
  });

  test('wide charts label fewer days', () => {
    expect(viewScale(14 * DAY).labelEvery).toBe(1);
    expect(viewScale(44 * DAY).labelEvery).toBeGreaterThan(3);
  });
});

describe('usage profile', () => {
  const DAY = 24 * HOUR;
  const reset = now + 30 * DAY;
  // Local-time fixtures, so the test holds in any timezone. 2026-11-11 is a Wednesday.
  const at = (day: number, hour: number, minute = 0) =>
    new Date(2026, 10, day, hour, minute).getTime();
  const learnedAt = at(11, 22);
  /** One point of usage per hour from 9:00 to 17:00 on weekdays, 10:00 to 12:00 on weekends. */
  const rhythm = (auth: string, fromDay: number, toDay: number): PoolHistoryPoint[] => {
    const points: PoolHistoryPoint[] = [];
    let used = 0;
    const add = (ms: number) =>
      points.push({
        t: sec(ms),
        auth,
        provider: 'claude',
        long_used: used / 100,
        long_reset: sec(reset),
      });
    add(at(fromDay, 0));
    for (let day = fromDay; day <= toDay; day++) {
      const weekend = [0, 6].includes(new Date(2026, 10, day).getDay());
      for (let hour = weekend ? 10 : 9; hour < (weekend ? 12 : 17); hour++) {
        used += 1;
        add(at(day, hour, 30));
      }
    }
    return points;
  };
  const pool = [{ ...account('a', 50, 100), resetAtMs: reset }];

  test('learns quiet nights and lighter weekends', () => {
    const points = rhythm('a', 2, 11);
    const profile = learnUsageProfile([points], pool, historyByAccount(points), learnedAt)!;
    expect(profile.weekday[3]).toBe(0);
    expect(profile.weekday[13]).toBeCloseTo(1, 1);
    expect(profile.weekend[3]).toBe(0);
    expect(profile.weekend[11]).toBeLessThan(profile.weekday[11]);
    const perDay = (rates: number[]) => rates.reduce((sum, rate) => sum + rate, 0);
    expect(perDay(profile.weekend)).toBeLessThan(perDay(profile.weekday) / 2);
    expect(profile.perWeek).toBeCloseTo(5 * 8 + 2 * 2, 0);
    expect(profileRate(profile, at(14, 11))).toBe(profile.weekend[11]);
  });

  test('ignores one-point jitter in the readings', () => {
    const base = rhythm('a', 2, 11);
    const jitter = base.flatMap((point) => [
      point,
      { ...point, t: point.t + 120, long_used: point.long_used - 0.01 },
      { ...point, t: point.t + 240 },
    ]);
    const steady = learnUsageProfile([base], pool, historyByAccount(base), learnedAt)!;
    const noisy = learnUsageProfile([jitter], pool, historyByAccount(jitter), learnedAt)!;
    expect(noisy.perWeek).toBeCloseTo(steady.perWeek, 5);
  });

  test('takes the shape from every credential and the level from the pool', () => {
    // 'old' left the pool; 'a' joined four days ago and burns twice as fast.
    const old = rhythm('old', 1, 7);
    const mine = rhythm('a', 8, 11).map((point) => ({ ...point, long_used: point.long_used * 2 }));
    const history = historyByAccount([...old, ...mine]);
    const profile = learnUsageProfile([old, mine], pool, history, learnedAt)!;
    expect(profile.weekday[3]).toBe(0);
    expect(profile.weekday[13]).toBeCloseTo(2, 0);
  });

  test('needs two days of history', () => {
    const points = rhythm('a', 11, 11);
    expect(learnUsageProfile([points], pool, historyByAccount(points), learnedAt)).toBeNull();
    expect(learnUsageProfile([], pool, new Map(), learnedAt)).toBeNull();
  });

  test('projection is flat overnight and the recent pace fades', () => {
    const points = rhythm('a', 2, 11);
    const profile = learnUsageProfile([points], pool, historyByAccount(points), learnedAt)!;
    // Burning 4 points/h at 22:00, when the profile expects nothing: a short session.
    const late = projectedRate(profile, 4, 1, learnedAt);
    expect(late(learnedAt)).toBeCloseTo(4, 5);
    expect(late(learnedAt + HOUR)).toBeCloseTo(2, 5);
    expect(late(at(12, 3))).toBeLessThan(0.2);
    expect(late(at(13, 13))).toBeCloseTo(1, 1);
    // Twice the usual pace at 13:00 scales the rhythm, so the night after stays flat.
    const busy = projectedRate(profile, 2, 1, at(11, 13));
    expect(busy(at(11, 13))).toBeCloseTo(2, 1);
    expect(busy(at(11, 16))).toBeCloseTo(1.5 * profile.weekday[16], 5);
    expect(busy(at(12, 3))).toBe(0);

    const projection = projectPool(pool, projectedRate(profile, 0, 1, learnedAt), learnedAt, at(13, 0));
    const value = (ms: number) => projection.series.filter((p) => p.t <= ms).at(-1)!.v;
    // Nothing overnight, then Thursday's eight working hours.
    expect(value(at(12, 7))).toBeCloseTo(50, 5);
    expect(value(at(12, 23))).toBeCloseTo(42, 0);
  });

  test('without a profile the recent rate stays constant', () => {
    const rate = projectedRate(null, 3, 1, now);
    expect(rate(now + 50 * HOUR)).toBe(3);
  });
});

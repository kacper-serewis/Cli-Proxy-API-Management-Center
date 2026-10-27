import { describe, expect, test } from 'bun:test';
import {
  accountFromHistory,
  burnRatePerHour,
  historyByAccount,
  projectPool,
  recordedSeries,
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

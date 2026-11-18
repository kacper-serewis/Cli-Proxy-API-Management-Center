import { describe, expect, test } from 'bun:test';
import { projectJointPool } from '../src/features/quota/jointQuotaProjection';
import {
  headroomAccounts,
  historyByAccount,
  projectPool,
} from '../src/features/quota/quotaPoolModel';
import type { PoolAccount } from '../src/features/quota/quotaPoolModel';

const HOUR = 3_600_000,
  now = 100_000_000;
const seat = (
  name: string,
  used: number,
  resetHours: number | null,
  short = false
): PoolAccount => ({
  name,
  displayName: name,
  remaining: 100 - used,
  resetAtMs: resetHours === null ? null : now + resetHours * HOUR,
  periodHours: short ? 5 : 168,
  startsOnUse: short,
});

describe('joint quota forecast (same cases as CliproxyBar)', () => {
  test('predicts split limits before either separate pool empties', () => {
    const long = [seat('a', 98, 5), seat('b', 65, 72)];
    const short = [seat('a', 0, null, true), seat('b', 80, 2, true)];
    const result = projectJointPool(
      long,
      short,
      () => 2,
      () => 20,
      new Map([['b', 20]]),
      now,
      now + 3 * HOUR
    );
    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0].start).toBeCloseTo(now + HOUR, 3);
    expect(result.gaps[0].end).toBe(now + 2 * HOUR);
    expect(Math.min(...result.long.series.map((p) => p.v))).toBeGreaterThan(0);
    expect(Math.min(...result.short.series.map((p) => p.v))).toBeGreaterThan(0);
    expect(projectPool(long, 2, now, now + 3 * HOUR).poolEmptyAt).toBeNull();
    expect(projectPool(short, 20, now, now + 3 * HOUR).poolEmptyAt).toBeNull();
    // Pause workload during the gap; resume when b resets. Both dimensions spend the
    // same workload shares: two hours of actual use, one hour paused.
    expect(result.long.series.at(-1)!.v).toBeCloseTo(37 - 4, 5);
    expect(result.short.resets[0].t).toBe(now + 2 * HOUR);
    expect(result.short.resets[0].gain).toBeCloseTo(90, 6);
  });

  test('honours a reset inside the step instead of forecasting a false gap', () => {
    const result = projectJointPool(
      [seat('a', 99, 5), seat('b', 50, 72)],
      [seat('a', 0, null, true), seat('b', 89, 0.025, true)],
      () => 2,
      () => 20,
      new Map([['b', 20]]),
      now,
      now + 0.5 * HOUR
    );
    expect(result.gaps).toHaveLength(0);
    expect(result.short.resets[0].gain).toBeCloseTo(89.5, 6);
  });

  test('both constraints must reset on the same seat to recover', () => {
    const result = projectJointPool(
      [seat('a', 99, 3), seat('b', 50, 72)],
      [seat('a', 90, 1, true), seat('b', 90, 2, true)],
      () => 0,
      () => 0,
      new Map(),
      now,
      now + 4 * HOUR
    );
    expect(result.gaps).toEqual([{ start: now, end: now + 2 * HOUR }]);
  });

  test('idle short windows begin on first use and stay idle without work', () => {
    const long = [seat('a', 0, 100)],
      short = [seat('a', 0, null, true)];
    const result = projectJointPool(
      long,
      short,
      (t) => (t < now + 2 * HOUR ? 0 : 1),
      (t) => (t < now + 2 * HOUR ? 0 : 10),
      new Map(),
      now,
      now + 8 * HOUR
    );
    expect(result.gaps).toHaveLength(0);
    expect(result.short.resets[0].t).toBe(now + 7 * HOUR);
    expect(result.short.resets[0].gain).toBeCloseTo(50, 6);
    expect(
      projectJointPool(
        long,
        short,
        () => 0,
        () => 0,
        new Map(),
        now,
        now + 8 * HOUR
      ).short.resets
    ).toHaveLength(0);
  });

  test('weekly-only pools and empty input are supported', () => {
    const result = projectJointPool(
      [seat('codex', 98, 10)],
      [],
      () => 1,
      () => 0,
      new Map(),
      now,
      now + 2 * HOUR
    );
    expect(result.gaps[0].start).toBeCloseTo(now + HOUR, 3);
    expect(result.gaps[0].end).toBeNull();
    expect(
      projectJointPool(
        [],
        [],
        () => 1,
        () => 1,
        new Map(),
        now,
        now + HOUR
      ).gaps
    ).toHaveLength(0);
  });

  test('a seat in its weekly reserve hands over new work and only takes the overflow', () => {
    // a reaches its reserve after an hour. b carries the work until its 5h window is
    // full, a covers the two hours until that window resets: no gap.
    const result = projectJointPool(
      [seat('a', 82, 30), seat('b', 40, 100)],
      [seat('a', 0, null, true), seat('b', 0, null, true)],
      () => 2,
      () => 30,
      new Map([['a', 1]]),
      now,
      now + 8 * HOUR
    );
    expect(result.gaps).toHaveLength(0);
    expect(result.short.resets).toHaveLength(2);
    expect(result.short.resets[0].t).toBeCloseTo(now + 5 * HOUR, 3);
    expect(result.short.resets[1].t).toBeCloseTo(now + 6 * HOUR, 3);
    expect(result.short.resets[0].gain).toBeCloseTo(60, 6);
    expect(result.short.resets[1].gain).toBeCloseTo(90, 6);
    // a: 84 at the hand-over plus two hours of overflow; b: five hours of work.
    expect(result.long.series.at(-1)!.v).toBeCloseTo(100 - 88 + (100 - 50), 6);
  });

  test('the weekly reserve is released once the expected usage is needed to finish it', () => {
    // a has 9 points left and 2 points an hour are expected: kept while more than 18
    // points are expected before its reset, so for three hours. After that it takes
    // half of the work, which is what finishes it exactly at its reset.
    const result = projectJointPool(
      [seat('a', 90, 12), seat('b', 10, 120)],
      [seat('a', 0, null, true), seat('b', 0, null, true)],
      () => 2,
      () => 10,
      new Map([['a', 1]]),
      now,
      now + 13 * HOUR
    );
    expect(result.gaps).toHaveLength(0);
    // b: three hours alone and two hours of half the work; a: five hours of half.
    expect(result.short.resets[0].t).toBeCloseTo(now + 5 * HOUR, 3);
    expect(Math.abs(result.short.resets[0].gain - 40)).toBeLessThan(1);
    expect(Math.abs(result.short.resets[1].t - (now + 8 * HOUR))).toBeLessThan(0.1 * HOUR);
    expect(Math.abs(result.short.resets[1].gain - 25)).toBeLessThan(1);
    expect(result.long.resets[0].t).toBe(now + 12 * HOUR);
    expect(Math.abs(result.long.resets[0].gain - 99)).toBeLessThan(0.5);
    expect(Math.abs(result.long.series.at(-1)!.v - (100 - 2 + (100 - 25)))).toBeLessThan(0.5);
    // With little usage expected nothing is held back: a works from the start.
    const quiet = projectJointPool(
      [seat('a', 90, 12), seat('b', 10, 120)],
      [seat('a', 0, null, true), seat('b', 0, null, true)],
      () => 1,
      () => 10,
      new Map([['a', 1]]),
      now,
      now + 6 * HOUR
    );
    expect(quiet.short.resets[0].gain).toBeCloseTo(50, 6);
    // Without a forecast the router keeps no reserve, and neither does the projection.
    const blind = projectJointPool(
      [seat('a', 90, 12), seat('b', 10, 120)],
      [seat('a', 0, null, true), seat('b', 0, null, true)],
      () => 2,
      () => 10,
      new Map([['a', 1]]),
      now,
      now + 6 * HOUR,
      false
    );
    expect(blind.short.resets[0].gain).toBeCloseTo(45, 6);
  });

  test('readings retain their high water only within the current window', () => {
    const history = historyByAccount([
      {
        t: now / 1000 - 120,
        auth: 'a',
        provider: 'claude',
        long_used: 0.99,
        long_reset: (now + HOUR) / 1000,
      },
      {
        t: now / 1000,
        auth: 'a',
        provider: 'claude',
        long_used: 0.98,
        long_reset: (now + HOUR) / 1000,
      },
    ]);
    expect(headroomAccounts([seat('a', 98, 1)], history, now)[0].remaining).toBe(1);
    expect(headroomAccounts([seat('a', 0, 169)], history, now + HOUR)[0].remaining).toBe(100);
  });
});

// Verify the real card uses the joint forecast for both plots and its headline.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { PoolCard } from '../src/features/quota/components/QuotaPool';
import { shortWindowHistory, viewScale } from '../src/features/quota/quotaPoolModel';
import en from '../src/i18n/locales/en.json';

test('pool card renders headroom loss, recovery, and bands on both joint charts', async () => {
  const i18n = createInstance();
  await i18n.init({ lng: 'en', resources: { en: { translation: en } }, interpolation: { escapeValue: false } });
  const long = [seat('a', 98, 5), seat('b', 65, 72)];
  const short = [seat('a', 0, null, true), seat('b', 80, 2, true)];
  const history = historyByAccount([
    { t: now / 1000 - 3600, auth: 'b', provider: 'claude', long_used: 0.64, long_reset: (now + 72 * HOUR) / 1000,
      short_used: 0.6, short_reset: (now + 2 * HOUR) / 1000 },
    { t: now / 1000, auth: 'b', provider: 'claude', long_used: 0.65, long_reset: (now + 72 * HOUR) / 1000,
      short_used: 0.8, short_reset: (now + 2 * HOUR) / 1000 },
  ]);
  const html = renderToStaticMarkup(createElement(I18nextProvider, { i18n }, createElement(PoolCard, {
    label: 'Claude', color: undefined, totalAccounts: 2, accounts: long, shortAccounts: short,
    history, shortHistory: shortWindowHistory(history), shapeHistory: [...history.values()],
    burnWindow: 1, now, scale: viewScale(6 * HOUR), startMs: now - HOUR, endMs: now + 5 * HOUR,
  })));
  expect(html.match(/Headroom lost/g)).toHaveLength(2);
  expect(html).toContain('Headroom returns');
  expect(html.match(/<rect /g)!.length).toBeGreaterThanOrEqual(2);
  expect(html).toContain('No safe headroom');
  expect(html).not.toContain('Pool empty');
  expect(html).not.toContain('NaN');
});

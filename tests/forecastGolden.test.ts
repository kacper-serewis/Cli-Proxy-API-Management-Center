import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { goldenForecast, goldenInput } from '../scripts/forecastGolden';
import type { GoldenFile } from '../scripts/forecastGolden';

/**
 * The menu bar app in the proxy fork computes the same forecast from the same history and
 * is tested against the same file. When this fails after a change to the model, apply the
 * change there too and regenerate the file in both repos (see scripts/forecastGolden.ts).
 */
test('the forecast still matches the golden file shared with the menu bar app', () => {
  const file = JSON.parse(
    readFileSync(new URL('./fixtures/forecast-golden.json', import.meta.url), 'utf8')
  ) as GoldenFile;
  // The rhythm is learned in local hours; bun test runs in UTC, like the file.
  expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(file.timeZone);
  const got = goldenForecast(goldenInput(file));
  const close = (a: number[] | null, b: number[] | null) => {
    expect(a === null).toBe(b === null);
    expect(a?.length).toBe(b?.length);
    a?.forEach((value, i) => expect(Math.abs(value - b![i])).toBeLessThan(1e-9));
  };
  close(got.weekday, file.expected.weekday);
  close(got.weekend, file.expected.weekend);
  close([got.recentBurn, got.shortBurn, got.shortPerLong ?? -1], [
    file.expected.recentBurn,
    file.expected.shortBurn,
    file.expected.shortPerLong ?? -1,
  ]);
  close(got.longRate, file.expected.longRate);
  close(got.shortRate, file.expected.shortRate);
  close(got.longUsed, file.expected.longUsed);
  close(got.shortUsed, file.expected.shortUsed);
  expect(got.events).toEqual(file.expected.events);
  // The file is only worth its name while it exercises the forecast.
  expect(file.expected.events.length).toBeGreaterThan(0);
  expect(file.expected.weekday).not.toBeNull();
});

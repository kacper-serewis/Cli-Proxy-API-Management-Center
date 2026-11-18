import { expect, test } from 'bun:test';
import {
  CLAUDE_USAGE_FRESH_MS,
  createClaudeUsageReader,
  isClaudeUsageStale,
  type ClaudeUsageSnapshot,
} from '../src/services/api/claudeUsageCache';

const t0 = Date.parse('2026-11-18T12:00:00Z');
const copy = (over: Partial<ClaudeUsageSnapshot> = {}): ClaudeUsageSnapshot => ({
  auth_id: 'a.json',
  auth_index: 'a',
  body: { five_hour: null, seven_day: null },
  observed_at: new Date(t0).toISOString(),
  last_status: 200,
  ...over,
});

function setup(listed: ClaudeUsageSnapshot[]) {
  let now = t0;
  const calls = { list: 0, refresh: [] as string[] };
  const reader = createClaudeUsageReader({
    list: async () => {
      calls.list += 1;
      return { accounts: listed };
    },
    refresh: async (authIndex) => {
      calls.refresh.push(authIndex);
      return copy({ auth_index: authIndex, observed_at: new Date(now).toISOString() });
    },
    now: () => now,
  });
  return { reader, calls, advance: (ms: number) => (now += ms) };
}

test('a current proxy copy is used as is, and cards share one list call', async () => {
  const { reader, calls, advance } = setup([copy(), copy({ auth_index: 'b' })]);
  advance(CLAUDE_USAGE_FRESH_MS - 1000);
  await Promise.all([reader.read('a'), reader.read('b')]);
  expect(calls).toEqual({ list: 1, refresh: [] });
});

test('an old copy, or none, is read through the proxy', async () => {
  const { reader, calls, advance } = setup([copy()]);
  advance(CLAUDE_USAGE_FRESH_MS + 1000);
  await reader.read('a');
  await reader.read('missing');
  expect(calls.refresh).toEqual(['a', 'missing']);
});

test('while the proxy backs off after a 429 the old copy is shown, not read again', async () => {
  const backoff = new Date(t0 + 20 * 60_000).toISOString();
  const { reader, calls, advance } = setup([copy({ last_status: 429, backoff_until: backoff })]);
  advance(10 * 60_000);
  const shown = await reader.read('a');
  expect(calls.refresh).toEqual([]);
  expect(isClaudeUsageStale(shown)).toBe(true);
});

test('a fresh read always goes through the proxy', async () => {
  const { reader, calls } = setup([copy()]);
  await reader.read('a', { fresh: true });
  expect(calls).toEqual({ list: 0, refresh: ['a'] });
});

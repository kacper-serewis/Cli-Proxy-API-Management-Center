import { describe, expect, test } from 'bun:test';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { renderToStaticMarkup } from 'react-dom/server';
import { AdaptiveReason } from '../src/features/quota/components/AdaptiveReason';
import { QuotaAccounts } from '../src/features/quota/components/QuotaAccounts';
import { parseRoutingStrategy } from '../src/hooks/useVisualConfig';
import type { AdaptiveDecision, RoutingCandidate } from '../src/services/api/routingActivity';
import en from '../src/i18n/locales/en.json';

const now = Date.parse('2026-10-28T12:00:00Z');
const i18n = createInstance();
await i18n.init({
  lng: 'en',
  resources: { en: { translation: en } },
  interpolation: { escapeValue: false },
});
const decision: AdaptiveDecision = {
  home: false,
  fresh: true,
  observed_at: '2026-10-28T11:58:00Z',
  eligible: true,
  draining: false,
  score: 0.42,
  band: 4,
  reason: 'surplus_selected',
  short: {
    inactive: false,
    used: 0.4,
    reset: '2026-10-28T14:00:00Z',
    reserve: 0.15,
    spare: 0.45,
    forecast: 0.1,
    buffer: 0.05,
    recent_rate: 0.05,
    typical_rate: 0.04,
    learning: true,
  },
  long: {
    inactive: false,
    used: 0.3,
    reset: '2026-10-30T12:00:00Z',
    reserve: 0.2,
    spare: 0.5,
    forecast: 0.17,
    buffer: 0.03,
    recent_rate: 0.003,
    typical_rate: 0.004,
    learning: true,
  },
};
const renderReason = (value: AdaptiveDecision) =>
  renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <AdaptiveReason decision={value} now={now} />
    </I18nextProvider>
  );

describe('adaptive routing explanations', () => {
  test('shows backend forecast arithmetic and uncertainty without inventing colleague attribution', () => {
    const html = renderReason(decision);
    expect(html).toContain('Why this account?');
    expect(html).toContain('45.0%');
    expect(html).toContain('forecast 10.0% + buffer 5.0%');
    expect(html).toContain('Observed 2m ago');
    expect(html).toContain('Learning:');
    expect(html).toContain('Score 0.420');
    expect(html).not.toContain('undefined');
  });
  test('does not describe last-resort routing as safe surplus', () => {
    const html = renderReason({ ...decision, reason: 'fallback', eligible: false });
    expect(html).toContain('No available account has confirmed safe surplus');
    expect(html).toContain('may consume reserved capacity');
  });
  test('handles stale missing windows and unknown future reason codes', () => {
    const html = renderReason({
      ...decision,
      reason: 'future-reason',
      fresh: false,
      short: undefined,
      long: undefined,
      observed_at: '0001-01-01T00:00:00Z',
    });
    expect(html).toContain('Both quota windows need a usable observation');
    expect(html).toContain('Stale or unknown observation');
    expect(html).not.toContain('NaN');
  });
  test('uses current routing usage instead of older history and labels inactive windows', () => {
    const candidate: RoutingCandidate = {
      auth: 'claude-example-team@example.test.json',
      known: true,
      short_usage: 0.4,
      saturated: false,
      unavailable: false,
      adaptive: { ...decision, short: { ...decision.short!, inactive: true } },
    };
    const html = renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <QuotaAccounts
          queues={{ claude: [candidate] }}
          sessions={[]}
          now={now}
          resolvedTheme="light"
          latest={
            new Map([
              [
                candidate.auth,
                {
                  auth: candidate.auth,
                  provider: 'claude',
                  t: now / 1000,
                  short_used: 0.9,
                  short_reset: now / 1000 + 3600,
                  long_used: 0.9,
                  long_reset: now / 1000 + 3600,
                },
              ],
            ])
          }
        />
      </I18nextProvider>
    );
    expect(html).toContain('40% used');
    expect(html).not.toContain('90% used');
    expect(html).toContain('Window starts on next use');
    expect(html).toContain('Next new chat · spare capacity');
    expect(html).not.toContain('skipping any at');
  });
  test('keeps fork strategies when reading the visual configuration', () => {
    expect(parseRoutingStrategy('adaptive-reserve')).toBe('adaptive-reserve');
    expect(parseRoutingStrategy('soonest-reset')).toBe('soonest-reset');
  });
});

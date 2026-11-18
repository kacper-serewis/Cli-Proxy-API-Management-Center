/**
 * Pooled quota chart per provider: recorded pool remaining, a projection that follows the
 * learned usage rhythm, and when the first credential and the whole pool run dry.
 *
 * All maths lives in quotaPoolModel.ts — this file is data loading and layout.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { useNow } from '@/hooks/useNow';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { quotaHistoryApi } from '@/services/api';
import { DAY_MS, HOUR_MS } from '@/utils/time/durations';
import { TYPE_COLORS } from '@/utils/quota';
import type { ResolvedTheme } from '@/types';
import {
  accountFromHistory,
  burnRatePerHour,
  fablePerLongPoint,
  fableWindowHistory,
  historyByAccount,
  learnUsageProfile,
  mergeResetLabels,
  POOL_AHEAD,
  POOL_VIEWS,
  projectedRate,
  projectPool,
  reactiveRate,
  recordedSeries,
  SHORT_PERIOD_HOURS,
  shortAccountFromHistory,
  shortPerLongPoint,
  shortWindowHistory,
  viewScale,
  viewTicks,
  WEEK_HOURS,
} from '../quotaPoolModel';
import type {
  PoolAccount,
  PoolHistoryPoint,
  PoolResetMark,
  PoolScale,
  PoolSeriesPoint,
  UsageProfile,
} from '../quotaPoolModel';
import type { QuotaFileEntry } from '../logic';
import type { QuotaCardState } from '../providers';
import {
  EVENTS_AHEAD_MS,
  SHORT_BURN_HOURS,
  forecastJointPool,
  headroomEvents,
  nextHeadroomGap,
} from '../jointQuotaProjection';
import type { JointProjection, HeadroomEvent, HeadroomGap } from '../jointQuotaProjection';
import styles from './QuotaPool.module.scss';

const POOL_PROVIDERS = [
  {
    type: 'claude',
    label: 'Claude',
    windowIds: ['seven-day'],
    shortWindowIds: ['five-hour'],
    fableWindowIds: ['seven-day-fable'],
  },
  // Which slot carries the weekly limit depends on the plan; take the longest. No 5h pool:
  // the same slot may be the weekly one.
  {
    type: 'codex',
    label: 'Codex',
    windowIds: ['five-hour', 'weekly', 'monthly'],
    shortWindowIds: [],
    fableWindowIds: [],
  },
] as const;
/**
 * The 5h pool reacts to the last hour's burn and has its own fixed range: two windows back
 * and one ahead. Days ahead its resets depend on when work starts, which nobody knows.
 */
const SHORT_BACK_MS = 2 * SHORT_PERIOD_HOURS * HOUR_MS;
const SHORT_AHEAD_MS = SHORT_PERIOD_HOURS * HOUR_MS;
const BURN_WINDOWS = [1, 3, 6] as const;
/** The proxy keeps 90 days (quotaHistoryRetention); the usage rhythm is learned from all of it. */
const HISTORY_DAYS = 90;
const HISTORY_REFRESH_MS = 2 * 60 * 1000;
const DEFAULT_VIEW = '7d';
const DEFAULT_AHEAD = '7d';

const NO_HISTORY: PoolHistoryPoint[][] = [];

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const formatAxisDay = (ms: number) => {
  const d = new Date(ms);
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()}`;
};
const formatShortDate = (ms: number) =>
  new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const formatHour = (ms: number) =>
  new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
const formatRange = (scale: PoolScale, startMs: number, endMs: number) =>
  scale.tickMs >= DAY_MS
    ? `${formatShortDate(startMs)} to ${formatShortDate(endMs - 1)}`
    : `${formatShortDate(startMs)} ${formatHour(startMs)} to ${formatShortDate(endMs)} ${formatHour(endMs)}`;
const formatInstant = (ms: number) =>
  `${WEEKDAYS[new Date(ms).getDay()]} ${new Date(ms).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  })}`;
const formatDuration = (ms: number) => {
  const minutes = Math.max(0, Math.round(ms / 60000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
};
const formatPercent = (value: number) => `${Math.round(value)}%`;

interface WindowLike {
  id?: string;
  usedPercent?: number | null;
  resetAtMs?: number | null;
  periodHours?: number | null;
}

/** The account-wide long window, the same one the proxy records. */
function liveAccount(
  entry: QuotaFileEntry,
  quota: QuotaCardState | undefined,
  windowIds: readonly string[],
  displayName: string,
  now: number,
  /** The 5h window: an expired one is idle, its successor only starts on first use. */
  short = false
): PoolAccount | null {
  if (!quota || (quota as { status?: string }).status !== 'success') return null;
  const window = ((quota as { windows?: WindowLike[] }).windows ?? [])
    .filter(
      (candidate) =>
        windowIds.includes(candidate.id ?? '') && typeof candidate.usedPercent === 'number'
    )
    .sort((a, b) => (b.periodHours ?? 0) - (a.periodHours ?? 0))[0];
  if (!window || typeof window.usedPercent !== 'number') return null;
  const periodHours =
    window.periodHours && window.periodHours > 0
      ? window.periodHours
      : short
        ? SHORT_PERIOD_HOURS
        : WEEK_HOURS;
  const rolledOver = typeof window.resetAtMs === 'number' && window.resetAtMs <= now;
  return {
    name: entry.file.name,
    displayName,
    remaining: rolledOver ? 100 : Math.min(100, Math.max(0, 100 - window.usedPercent)),
    resetAtMs:
      typeof window.resetAtMs === 'number'
        ? rolledOver
          ? short
            ? null
            : window.resetAtMs + periodHours * HOUR_MS
          : window.resetAtMs
        : null,
    periodHours,
    ...(short ? { startsOnUse: true } : {}),
  };
}

export interface QuotaPoolProps {
  entries: QuotaFileEntry[];
  quotaFor: (entry: QuotaFileEntry) => QuotaCardState | undefined;
  displayNameFor: (name: string) => string;
  resolvedTheme: ResolvedTheme;
}

export function QuotaPool({ entries, quotaFor, displayNameFor, resolvedTheme }: QuotaPoolProps) {
  const now = useNow();
  const [burnWindow, setBurnWindow] = useLocalStorage<number>('quota-pool-burn-window', 3);
  const [viewId, setViewId] = useLocalStorage<string>('quota-pool-view', DEFAULT_VIEW);
  const view =
    POOL_VIEWS.find((candidate) => candidate.id === viewId) ??
    POOL_VIEWS.find((candidate) => candidate.id === DEFAULT_VIEW)!;
  const [aheadId, setAheadId] = useLocalStorage<string>('quota-pool-ahead', DEFAULT_AHEAD);
  const ahead =
    POOL_AHEAD.find((candidate) => candidate.id === aheadId) ??
    POOL_AHEAD.find((candidate) => candidate.id === DEFAULT_AHEAD)!;
  const [points, setPoints] = useState<PoolHistoryPoint[]>([]);
  const [historyError, setHistoryError] = useState(false);

  const loadHistory = useCallback(async () => {
    try {
      const response = await quotaHistoryApi.list(Date.now() - HISTORY_DAYS * DAY_MS);
      setPoints(response.points ?? []);
      setHistoryError(false);
    } catch {
      // Older proxies don't have the endpoint; the pool still works from live values.
      setHistoryError(true);
    }
  }, []);

  useEffect(() => {
    void loadHistory();
    const timer = window.setInterval(() => void loadHistory(), HISTORY_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [loadHistory]);

  const history = useMemo(() => historyByAccount(points), [points]);
  const shortHistory = useMemo(() => shortWindowHistory(history), [history]);
  const fableHistory = useMemo(() => fableWindowHistory(history), [history]);

  // Now sits where the recorded span ends and the projected one begins.
  const startMs = now - view.spanMs;
  const endMs = now + ahead.spanMs;
  const scale = useMemo(() => viewScale(view.spanMs + ahead.spanMs), [view, ahead]);
  const providerHistory = useMemo(() => {
    const byProvider = new Map<string, PoolHistoryPoint[][]>();
    for (const list of history.values()) {
      const provider = list[0].provider;
      byProvider.set(provider, [...(byProvider.get(provider) ?? []), list]);
    }
    return byProvider;
  }, [history]);

  const pools = useMemo(
    () =>
      POOL_PROVIDERS.map((provider) => {
        const providerEntries = entries.filter(
          (entry) => entry.type === provider.type && !entry.file.disabled
        );
        const accounts = providerEntries
          .map((entry) => {
            const displayName = displayNameFor(entry.file.name);
            return (
              liveAccount(entry, quotaFor(entry), provider.windowIds, displayName, now) ??
              accountFromHistory(entry.file.name, displayName, history.get(entry.file.name), now)
            );
          })
          .filter((account): account is PoolAccount => account !== null);
        const shortAccounts =
          provider.shortWindowIds.length === 0
            ? []
            : providerEntries
                .map((entry) => {
                  const displayName = displayNameFor(entry.file.name);
                  return (
                    liveAccount(
                      entry,
                      quotaFor(entry),
                      provider.shortWindowIds,
                      displayName,
                      now,
                      true
                    ) ??
                    shortAccountFromHistory(
                      entry.file.name,
                      displayName,
                      shortHistory.get(entry.file.name),
                      now
                    )
                  );
                })
                .filter((account): account is PoolAccount => account !== null);
        // The Fable-only weekly window, for the seats that report one.
        const fableAccounts =
          provider.fableWindowIds.length === 0
            ? []
            : providerEntries
                .map((entry) => {
                  const displayName = displayNameFor(entry.file.name);
                  return (
                    liveAccount(
                      entry,
                      quotaFor(entry),
                      provider.fableWindowIds,
                      displayName,
                      now
                    ) ??
                    accountFromHistory(
                      entry.file.name,
                      displayName,
                      fableHistory.get(entry.file.name),
                      now
                    )
                  );
                })
                .filter((account): account is PoolAccount => account !== null);
        return {
          ...provider,
          total: providerEntries.length,
          accounts,
          shortAccounts,
          fableAccounts,
        };
      }).filter((pool) => pool.total > 0),
    [entries, quotaFor, displayNameFor, history, shortHistory, fableHistory, now]
  );

  if (pools.length === 0) return null;

  return (
    <section className={styles.pool}>
      <div className={styles.controls}>
        <span className={styles.controlLabel}>Recent pace</span>
        <div className={styles.segmented}>
          {BURN_WINDOWS.map((hours) => (
            <button
              key={hours}
              type="button"
              aria-pressed={burnWindow === hours}
              onClick={() => setBurnWindow(hours)}
            >
              {hours}h
            </button>
          ))}
        </div>
        <span className={styles.controlLabel}>Back</span>
        <div className={styles.segmented}>
          {POOL_VIEWS.map((option) => (
            <button
              key={option.id}
              type="button"
              aria-pressed={view.id === option.id}
              onClick={() => setViewId(option.id)}
            >
              {option.label}
            </button>
          ))}
        </div>
        <span className={styles.controlLabel}>Ahead</span>
        <div className={styles.segmented}>
          {POOL_AHEAD.map((option) => (
            <button
              key={option.id}
              type="button"
              aria-pressed={ahead.id === option.id}
              onClick={() => setAheadId(option.id)}
            >
              {option.label}
            </button>
          ))}
        </div>
        {historyError && (
          <span className={styles.warning}>
            Quota history unavailable; showing live values only
          </span>
        )}
        <span className={styles.range}>{formatRange(scale, startMs, endMs)}</span>
      </div>

      {pools.map((pool) => (
        <PoolCard
          key={pool.type}
          label={pool.label}
          color={
            TYPE_COLORS[pool.type]?.[resolvedTheme]?.text ?? TYPE_COLORS[pool.type]?.light.text
          }
          totalAccounts={pool.total}
          accounts={pool.accounts}
          shortAccounts={pool.shortAccounts}
          shortHistory={shortHistory}
          fableAccounts={pool.fableAccounts}
          fableHistory={fableHistory}
          history={history}
          shapeHistory={providerHistory.get(pool.type) ?? NO_HISTORY}
          burnWindow={burnWindow}
          now={now}
          scale={scale}
          startMs={startMs}
          endMs={endMs}
        />
      ))}
    </section>
  );
}

interface PoolCardProps {
  label: string;
  color: string | undefined;
  totalAccounts: number;
  accounts: PoolAccount[];
  /** The same credentials' 5h windows; empty when the provider has no 5h pool. */
  shortAccounts: PoolAccount[];
  shortHistory: Map<string, PoolHistoryPoint[]>;
  /** The same credentials' Fable-only weekly windows; empty when none is reported. */
  fableAccounts?: PoolAccount[];
  fableHistory?: Map<string, PoolHistoryPoint[]>;
  history: Map<string, PoolHistoryPoint[]>;
  /** Every credential of this provider with history, in or out of the pool. */
  shapeHistory: PoolHistoryPoint[][];
  burnWindow: number;
  now: number;
  scale: PoolScale;
  startMs: number;
  endMs: number;
}

export function PoolCard({
  label,
  color,
  totalAccounts,
  accounts,
  shortAccounts,
  shortHistory,
  fableAccounts = NO_ACCOUNTS,
  fableHistory = NO_FABLE_HISTORY,
  history,
  shapeHistory,
  burnWindow,
  now,
  scale,
  startMs,
  endMs,
}: PoolCardProps) {
  const { t } = useTranslation();
  const capacity = accounts.length * 100;
  const remaining = accounts.reduce((sum, account) => sum + account.remaining, 0);
  const burn = useMemo(
    () => burnRatePerHour(accounts, history, burnWindow, now),
    [accounts, history, burnWindow, now]
  );
  const recorded = useMemo(
    () => recordedSeries(accounts, history, startMs, Math.min(now, endMs)),
    [accounts, history, startMs, endMs, now]
  );
  // Project far enough to answer "when does the pool run out" even past the view.
  const projectionEnd = Math.max(endMs, now + 14 * DAY_MS);
  const profile = useMemo(
    () => learnUsageProfile(shapeHistory, accounts, history, now),
    [shapeHistory, accounts, history, now]
  );
  const joint = useMemo(() => {
    if (
      accounts.length !== totalAccounts ||
      (label === 'Claude' && shortAccounts.length !== accounts.length)
    )
      return null;
    return forecastJointPool({
      accounts,
      shortAccounts,
      history,
      shortHistory,
      profile,
      burn,
      burnWindow,
      now,
      end: projectionEnd,
    });
  }, [
    accounts,
    totalAccounts,
    label,
    shortAccounts,
    shortHistory,
    history,
    profile,
    burn,
    burnWindow,
    now,
    projectionEnd,
  ]);
  const independent = useMemo(
    () => projectPool(accounts, projectedRate(profile, burn, burnWindow, now), now, projectionEnd),
    [accounts, profile, burn, burnWindow, now, projectionEnd]
  );
  const projection = joint?.long ?? independent;
  const gap = joint?.gaps[0];
  const events = useMemo(
    () => (joint ? headroomEvents(joint.gaps, now, now + EVENTS_AHEAD_MS, projectionEnd) : null),
    [joint, now, projectionEnd]
  );
  const nextReset = projection.resets[0] ?? null;

  const stats = [
    {
      label: joint ? t('quota_headroom.lost') : 'Pool empty',
      value: joint
        ? gap
          ? gap.start <= now
            ? t('quota_headroom.now')
            : formatInstant(gap.start)
          : t('quota_headroom.none', { date: formatShortDate(projectionEnd) })
        : projection.poolEmptyAt
          ? formatInstant(projection.poolEmptyAt)
          : `Not by ${formatShortDate(projectionEnd)}`,
    },
    {
      label: joint ? t('quota_headroom.returns') : 'First empty',
      value: joint
        ? gap?.end
          ? formatInstant(gap.end)
          : gap
            ? t('quota_headroom.none', { date: formatShortDate(projectionEnd) })
            : '—'
        : projection.firstEmpty
          ? `${projection.firstEmpty.name} in ${formatDuration(projection.firstEmpty.t - now)}`
          : `None by ${formatShortDate(projectionEnd)}`,
    },
    {
      label: 'Next reset',
      value: nextReset ? `+${formatPercent(nextReset.gain)} ${formatInstant(nextReset.t)}` : 'None',
    },
    { label: `Burn, last ${burnWindow}h`, value: `${burn.toFixed(1)}%/h` },
    {
      label: 'Typical week',
      value: profile
        ? `${formatPercent(profile.perWeek)} of ${formatPercent(capacity)}`
        : 'Learning',
    },
  ];

  const missing = totalAccounts - accounts.length;

  return (
    <article className={styles.card} style={{ '--pool-color': color } as CSSProperties}>
      <header className={styles.cardHead}>
        <div>
          <div className={styles.title}>
            {label} <span className={styles.subtle}>{totalAccounts} accounts</span>
          </div>
          <div className={styles.big}>
            {formatPercent(remaining)}
            <span className={styles.subtle}> of {formatPercent(capacity)}</span>
          </div>
          {missing > 0 && (
            <div className={styles.note}>
              {missing} account{missing === 1 ? '' : 's'} without quota data yet. Refresh
              credentials to include {missing === 1 ? 'it' : 'them'}.
            </div>
          )}
        </div>
        <dl className={styles.stats}>
          {stats.map((stat) => (
            <div key={stat.label}>
              <dt>{stat.label}</dt>
              <dd>{stat.value}</dd>
            </div>
          ))}
        </dl>
      </header>

      {capacity > 0 && (
        <PoolChart
          capacity={capacity}
          recorded={recorded.series}
          projected={projection.series}
          resets={[...recorded.resets, ...projection.resets]}
          poolEmptyAt={projection.poolEmptyAt}
          gaps={joint?.gaps}
          now={now}
          scale={scale}
          startMs={startMs}
          endMs={endMs}
        />
      )}

      <p className={styles.note}>
        {joint
          ? t('quota_headroom.scenario')
          : t(
              profile ? 'adaptive_routing.pool_scenario_learned' : 'adaptive_routing.pool_scenario'
            )}
      </p>
      <footer className={styles.legend}>
        <span>Pool</span>
        <span className={styles.legendRecorded}>Recorded</span>
        <span className={styles.legendProjected}>Projected</span>
        {joint && <span className={styles.headroomLegend}>{t('quota_headroom.gap')}</span>}
      </footer>
      {events && (
        <HeadroomEvents
          events={events}
          next={joint ? nextHeadroomGap(joint.gaps, now + EVENTS_AHEAD_MS) : null}
          accounts={accounts}
        />
      )}

      {shortAccounts.length > 0 && (
        <ShortPool
          accounts={shortAccounts}
          longAccounts={accounts}
          history={history}
          shortHistory={shortHistory}
          profile={profile}
          joint={joint}
          now={now}
        />
      )}
      {fableAccounts.length > 0 && (
        <FablePool
          accounts={fableAccounts}
          longAccounts={accounts}
          history={history}
          fableHistory={fableHistory}
          profile={profile}
          weeklyBurn={burn}
          burnWindow={burnWindow}
          now={now}
          scale={scale}
          startMs={startMs}
          endMs={endMs}
        />
      )}
    </article>
  );
}

const formatDay = (ms: number) =>
  `${WEEKDAYS[new Date(ms).getDay()]} ${new Date(ms).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  })}`;

/**
 * The expected periods without safe headroom in the coming week: when, how long, how
 * much of that in working hours, and which limit holds each seat back.
 */
export function HeadroomEvents({
  events,
  next = null,
  accounts,
  title = true,
}: {
  events: HeadroomEvent[];
  /** When the first gap after the listed week starts, if the projection sees one. */
  next?: number | null;
  accounts: PoolAccount[];
  /** Off where the surrounding section already carries the heading. */
  title?: boolean;
}) {
  const { t } = useTranslation();
  const nameOf = (name: string) =>
    accounts.find((account) => account.name === name)?.displayName ?? name;
  const total = events.reduce((sum, event) => sum + event.end - event.start, 0);
  const working = events.reduce((sum, event) => sum + event.workingMs, 0);
  return (
    <section className={styles.events}>
      {title && <div className={styles.eventsTitle}>{t('quota_headroom.events_title')}</div>}
      {events.length === 0 ? (
        <p className={styles.note}>{t('quota_headroom.events_none')}</p>
      ) : (
        <>
          <table className={styles.eventsTable}>
            <thead>
              <tr>
                <th>{t('quota_headroom.events_when')}</th>
                <th>{t('quota_headroom.events_length')}</th>
                <th>{t('quota_headroom.events_working')}</th>
                <th>{t('quota_headroom.events_cause')}</th>
              </tr>
            </thead>
            <tbody>
              {events.map((event) => (
                <tr key={event.start}>
                  <td>
                    {formatDay(event.start)} {formatHour(event.start)} –{' '}
                    {formatDay(event.end) === formatDay(event.start)
                      ? formatHour(event.end)
                      : `${formatDay(event.end)} ${formatHour(event.end)}`}
                  </td>
                  <td>
                    {event.ended ? '' : `${t('quota_headroom.events_at_least')} `}
                    {formatDuration(event.end - event.start)}
                  </td>
                  <td>{event.workingMs > 0 ? formatDuration(event.workingMs) : '—'}</td>
                  <td>
                    {event.blocked
                      .map(
                        (seat) =>
                          `${nameOf(seat.name)}: ${t(
                            seat.limit === 'long'
                              ? 'quota_headroom.events_week'
                              : 'quota_headroom.events_five_hour'
                          )}`
                      )
                      .join(', ')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className={styles.note}>
            {t('quota_headroom.events_total', {
              total: formatDuration(total),
              working: formatDuration(working),
            })}
          </p>
        </>
      )}
      {next !== null && (
        <p className={styles.note}>
          {t('quota_headroom.events_next', { when: `${formatDay(next)} ${formatHour(next)}` })}
        </p>
      )}
    </section>
  );
}

const NO_ACCOUNTS: PoolAccount[] = [];
const NO_FABLE_HISTORY = new Map<string, PoolHistoryPoint[]>();

interface FablePoolProps {
  accounts: PoolAccount[];
  longAccounts: PoolAccount[];
  history: Map<string, PoolHistoryPoint[]>;
  fableHistory: Map<string, PoolHistoryPoint[]>;
  profile: UsageProfile | null;
  weeklyBurn: number;
  burnWindow: number;
  now: number;
  scale: PoolScale;
  startMs: number;
  endMs: number;
}

/**
 * The pooled Fable-only weekly window under the other charts, on the weekly range. Each
 * seat has this window next to its week, with the same reset; a seat that is out of it
 * still serves other models, so it is not part of the headroom bands above.
 */
function FablePool({
  accounts,
  longAccounts,
  history,
  fableHistory,
  profile,
  weeklyBurn,
  burnWindow,
  now,
  scale,
  startMs,
  endMs,
}: FablePoolProps) {
  const capacity = accounts.length * 100;
  const remaining = accounts.reduce((sum, account) => sum + account.remaining, 0);
  // While the window has been recorded for less than the burn window, measure over what
  // there is: dividing a first hour of usage by six would hide it.
  const burn = useMemo(() => {
    const first = Math.min(
      ...accounts.map((account) => fableHistory.get(account.name)?.[0]?.t ?? Infinity)
    );
    const recordedHours = Number.isFinite(first) ? (now - first * 1000) / HOUR_MS : burnWindow;
    return burnRatePerHour(
      accounts,
      fableHistory,
      Math.min(burnWindow, Math.max(0.5, recordedHours)),
      now
    );
  }, [accounts, fableHistory, burnWindow, now]);
  const pointsPerWeeklyPoint = useMemo(
    () => fablePerLongPoint(longAccounts, history, fableHistory, now),
    [longAccounts, history, fableHistory, now]
  );
  const learned = profile !== null && pointsPerWeeklyPoint !== null;
  const recorded = useMemo(
    () => recordedSeries(accounts, fableHistory, startMs, Math.min(now, endMs)),
    [accounts, fableHistory, startMs, endMs, now]
  );
  const projectionEnd = Math.max(endMs, now + 14 * DAY_MS);
  const projection = useMemo(() => {
    const weekly = projectedRate(profile, weeklyBurn, burnWindow, now);
    const rate =
      profile !== null && pointsPerWeeklyPoint !== null
        ? (t: number) => weekly(t) * pointsPerWeeklyPoint
        : burn;
    return projectPool(accounts, rate, now, projectionEnd);
  }, [accounts, profile, pointsPerWeeklyPoint, weeklyBurn, burnWindow, burn, now, projectionEnd]);
  const nextReset = projection.resets[0] ?? null;
  const out = accounts.filter((account) => account.remaining <= 1);

  const stats = [
    {
      label: 'Fable runs out',
      value:
        remaining <= accounts.length
          ? 'Now'
          : projection.poolEmptyAt
            ? formatInstant(projection.poolEmptyAt)
            : `Not by ${formatShortDate(projectionEnd)}`,
    },
    {
      label: 'Seats out of Fable',
      value:
        out.length > 0
          ? out
              .map(
                (account) =>
                  `${account.displayName}${account.resetAtMs ? ` until ${formatInstant(account.resetAtMs)}` : ''}`
              )
              .join(', ')
          : projection.firstEmpty
            ? `${projection.firstEmpty.name} in ${formatDuration(projection.firstEmpty.t - now)}`
            : 'None',
    },
    {
      label: 'Next reset',
      value: nextReset ? `+${formatPercent(nextReset.gain)} ${formatInstant(nextReset.t)}` : 'None',
    },
    {
      label: 'Fable per weekly point',
      value: pointsPerWeeklyPoint !== null ? `${pointsPerWeeklyPoint.toFixed(1)}×` : 'Learning',
    },
  ];

  return (
    <section className={styles.short}>
      <header className={styles.cardHead}>
        <div>
          <div className={styles.shortTitle}>
            Fable week <span className={styles.subtle}>Fable-only limit per seat</span>
          </div>
          <div className={styles.medium}>
            {formatPercent(remaining)}
            <span className={styles.subtle}> of {formatPercent(capacity)}</span>
          </div>
        </div>
        <dl className={styles.stats}>
          {stats.map((stat) => (
            <div key={stat.label}>
              <dt>{stat.label}</dt>
              <dd>{stat.value}</dd>
            </div>
          ))}
        </dl>
      </header>
      <div className={styles.shortChart}>
        <PoolChart
          capacity={capacity}
          recorded={recorded.series}
          projected={projection.series}
          resets={[...recorded.resets, ...projection.resets]}
          poolEmptyAt={projection.poolEmptyAt}
          now={now}
          scale={scale}
          startMs={startMs}
          endMs={endMs}
        />
      </div>
      <p className={styles.note}>
        Each seat has a weekly limit for Fable alone, next to its week and with the same reset.
        A seat that is out of it still serves other models, so new Fable chats skip it.{' '}
        {learned
          ? 'The projection follows the learned weekly rhythm, at what the recent mix of models costs in Fable points.'
          : 'Until enough Fable usage is recorded, the projection holds the recent Fable burn constant.'}
      </p>
    </section>
  );
}

interface ShortPoolProps {
  accounts: PoolAccount[];
  longAccounts: PoolAccount[];
  history: Map<string, PoolHistoryPoint[]>;
  shortHistory: Map<string, PoolHistoryPoint[]>;
  profile: UsageProfile | null;
  joint: JointProjection | null;
  now: number;
}

/**
 * The pooled 5h window under the weekly chart, on its own range of hours. The projection
 * starts at the last hour's burn and then follows the learned rhythm.
 */
function ShortPool({
  accounts,
  longAccounts,
  history,
  shortHistory,
  profile,
  joint,
  now,
}: ShortPoolProps) {
  const { t } = useTranslation();
  const capacity = accounts.length * 100;
  const remaining = accounts.reduce((sum, account) => sum + account.remaining, 0);
  const startMs = now - SHORT_BACK_MS;
  const endMs = now + SHORT_AHEAD_MS;
  const scale = useMemo(() => viewScale(SHORT_BACK_MS + SHORT_AHEAD_MS), []);
  const burn = useMemo(
    () => burnRatePerHour(accounts, shortHistory, SHORT_BURN_HOURS, now, true),
    [accounts, shortHistory, now]
  );
  const pointsPerWeeklyPoint = useMemo(
    () => shortPerLongPoint(longAccounts, history, shortHistory, now),
    [longAccounts, history, shortHistory, now]
  );
  const learned = profile !== null && pointsPerWeeklyPoint !== null;
  const recorded = useMemo(
    () => recordedSeries(accounts, shortHistory, startMs, now),
    [accounts, shortHistory, startMs, now]
  );
  const independent = useMemo(
    () =>
      projectPool(
        accounts,
        reactiveRate(profile, pointsPerWeeklyPoint, burn, SHORT_BURN_HOURS, now),
        now,
        endMs
      ),
    [accounts, profile, pointsPerWeeklyPoint, burn, now, endMs]
  );
  const projection = joint?.short ?? independent;
  const gap = joint?.gaps.find((g) => g.start < endMs);
  const lowest = projection.series
    .filter((point) => point.t <= endMs)
    .reduce((min, point) => Math.min(min, point.v), remaining);
  const nextReset = projection.resets[0] ?? null;

  const stats = [
    {
      label: joint ? t('quota_headroom.lost') : 'Pool empty',
      value: joint
        ? gap
          ? gap.start <= now
            ? t('quota_headroom.now')
            : formatHour(gap.start)
          : t('quota_headroom.next_five')
        : projection.poolEmptyAt
          ? formatHour(projection.poolEmptyAt)
          : 'Not in the next 5h',
    },
    { label: 'Lowest point', value: `${formatPercent(lowest)} left` },
    {
      label: 'Next reset',
      value: nextReset ? `+${formatPercent(nextReset.gain)} ${formatHour(nextReset.t)}` : 'None',
    },
    { label: `Burn, last ${SHORT_BURN_HOURS}h`, value: `${burn.toFixed(1)}%/h` },
  ];

  return (
    <section className={styles.short}>
      <header className={styles.cardHead}>
        <div>
          <div className={styles.shortTitle}>
            5-hour window <span className={styles.subtle}>last 10h and next 5h</span>
          </div>
          <div className={styles.medium}>
            {formatPercent(remaining)}
            <span className={styles.subtle}> of {formatPercent(capacity)}</span>
          </div>
        </div>
        <dl className={styles.stats}>
          {stats.map((stat) => (
            <div key={stat.label}>
              <dt>{stat.label}</dt>
              <dd>{stat.value}</dd>
            </div>
          ))}
        </dl>
      </header>
      <div className={styles.shortChart}>
        <PoolChart
          capacity={capacity}
          recorded={recorded.series}
          projected={projection.series}
          resets={[...recorded.resets, ...projection.resets]}
          poolEmptyAt={projection.poolEmptyAt}
          gaps={joint?.gaps}
          now={now}
          scale={scale}
          startMs={startMs}
          endMs={endMs}
        />
      </div>
      <p className={styles.note}>
        {learned
          ? 'The 5-hour projection starts at the last hour\u2019s burn, which fades within a couple of hours, and then follows the learned usage rhythm. An idle window is full and only starts again on first use.'
          : 'The 5-hour projection holds the last hour\u2019s burn constant until there is enough history to learn the usage rhythm.'}
      </p>
    </section>
  );
}

const CHART_W = 1000;
const CHART_H = 280;

interface PoolChartProps {
  capacity: number;
  recorded: PoolSeriesPoint[];
  projected: PoolSeriesPoint[];
  resets: PoolResetMark[];
  poolEmptyAt: number | null;
  gaps?: HeadroomGap[];
  now: number;
  scale: PoolScale;
  startMs: number;
  endMs: number;
}

/** Keep a label centred on `pct` inside the plot instead of spilling past its edges. */
const edgeShift = (pct: number) => (pct < 4 ? '0%' : pct > 96 ? '-100%' : '-50%');

function PoolChart({
  capacity,
  recorded,
  projected,
  resets,
  poolEmptyAt,
  gaps = [],
  now,
  scale,
  startMs,
  endMs,
}: PoolChartProps) {
  const { t } = useTranslation();
  const x = (t: number) => ((t - startMs) / (endMs - startMs)) * CHART_W;
  const y = (v: number) => CHART_H - (Math.min(Math.max(v, 0), capacity) / capacity) * CHART_H;
  const pct = (t: number) => ((t - startMs) / (endMs - startMs)) * 100;
  const inView = (t: number) => t >= startMs && t <= endMs;

  const clip = (series: PoolSeriesPoint[]) => {
    const visible = series.filter((point) => inView(point.t));
    // Keep the line continuous across the left edge.
    const before = series.filter((point) => point.t < startMs).pop();
    return before ? [{ t: startMs, v: before.v }, ...visible] : visible;
  };
  const line = (series: PoolSeriesPoint[]) =>
    series
      .map((point, i) => `${i === 0 ? 'M' : 'L'}${x(point.t).toFixed(1)},${y(point.v).toFixed(1)}`)
      .join('');
  const area = (series: PoolSeriesPoint[]) =>
    series.length < 2
      ? ''
      : `${line(series)}L${x(series[series.length - 1].t).toFixed(1)},${CHART_H}L${x(series[0].t).toFixed(1)},${CHART_H}Z`;

  const recordedVisible = clip(recorded);
  const projectedVisible = clip(projected);
  const ticks = viewTicks(scale, startMs, endMs);
  const dayTicks = scale.tickMs >= DAY_MS;
  const axisLabels = ticks.flatMap((tick, i) => {
    if (dayTicks) {
      return i % scale.labelEvery === 0
        ? [{ t: tick, at: pct(tick + DAY_MS / 2), text: formatAxisDay(tick) }]
        : [];
    }
    const hour = new Date(tick).getHours();
    const labelHours = (scale.tickMs / HOUR_MS) * scale.labelEvery;
    if (hour % labelHours !== 0 || pct(tick) < 3 || pct(tick) > 97) return [];
    return [{ t: tick, at: pct(tick), text: hour === 0 ? formatAxisDay(tick) : formatHour(tick) }];
  });
  const resetLabels = mergeResetLabels(resets, startMs, endMs);
  const nowInView = inView(now);
  const emptyPct = poolEmptyAt === null ? null : pct(poolEmptyAt);

  return (
    <div className={styles.chart}>
      <div className={styles.yAxis}>
        <span style={{ top: '0%' }}>{formatPercent(capacity)}</span>
        <span style={{ top: '50%' }}>{formatPercent(capacity / 2)}</span>
        <span style={{ top: '100%' }}>0%</span>
      </div>
      <div className={styles.plot}>
        <svg viewBox={`0 0 ${CHART_W} ${CHART_H}`} preserveAspectRatio="none" aria-hidden="true">
          {[0, 0.5, 1].map((fraction) => (
            <line
              key={fraction}
              className={styles.grid}
              x1={0}
              x2={CHART_W}
              y1={fraction * CHART_H}
              y2={fraction * CHART_H}
            />
          ))}
          {ticks.map((tick) => (
            <line
              key={tick}
              className={styles.gridDay}
              x1={x(tick)}
              x2={x(tick)}
              y1={0}
              y2={CHART_H}
            />
          ))}
          {gaps
            .filter((gap) => gap.start < endMs && (gap.end ?? endMs) > startMs)
            .map((gap) => (
              <rect
                key={gap.start}
                className={styles.headroomGap}
                x={x(Math.max(startMs, gap.start))}
                y={0}
                width={x(Math.min(endMs, gap.end ?? endMs)) - x(Math.max(startMs, gap.start))}
                height={CHART_H}
              />
            ))}
          <path className={styles.areaRecorded} d={area(recordedVisible)} />
          <path className={styles.areaProjected} d={area(projectedVisible)} />
          <path className={styles.lineRecorded} d={line(recordedVisible)} />
          <path className={styles.lineProjected} d={line(projectedVisible)} />
        </svg>

        {gaps.length > 0 && inView(gaps[0].start) && (
          <div className={styles.headroomMark} style={{ left: `${pct(gaps[0].start)}%` }}>
            <span style={{ transform: `translateX(${edgeShift(pct(gaps[0].start))})` }}>
              {t('quota_headroom.gap')}
            </span>
          </div>
        )}
        {nowInView && (
          <div className={styles.now} style={{ left: `${pct(now)}%` }}>
            {/* With no projection shown now is the right edge; keep the label inside the plot. */}
            <span style={{ transform: `translateX(${edgeShift(pct(now))})` }}>Now</span>
          </div>
        )}
        {resetLabels.map((mark) => (
          <span
            key={`${mark.t}-${mark.v}`}
            className={styles.resetLabel}
            style={{
              left: `${pct(mark.t)}%`,
              top: `${(y(mark.v) / CHART_H) * 100}%`,
              transform: `translate(${edgeShift(pct(mark.t))}, -140%)`,
            }}
          >
            +{formatPercent(mark.gain)}
          </span>
        ))}
        {poolEmptyAt !== null && emptyPct !== null && inView(poolEmptyAt) && (
          <>
            <span className={styles.emptyDot} style={{ left: `${emptyPct}%` }} />
            {/* Beside the dot, over the flat empty stretch rather than the falling line. */}
            <span
              className={styles.emptyLabel}
              style={{
                left: `${emptyPct}%`,
                transform:
                  emptyPct > 80 ? 'translate(calc(-100% - 8px), -140%)' : 'translate(8px, -140%)',
              }}
            >
              Empty {formatInstant(poolEmptyAt)}
            </span>
          </>
        )}
        <div className={styles.xAxis}>
          {axisLabels.map((label) => (
            <span key={label.t} style={{ left: `${label.at}%` }}>
              {label.text}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

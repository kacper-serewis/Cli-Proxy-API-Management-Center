/**
 * Pooled quota chart per provider: recorded pool remaining, a projection at the recent
 * burn rate, and when the first credential and the whole pool run dry.
 *
 * All maths lives in quotaPoolModel.ts — this file is data loading and layout.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { useNow } from '@/hooks/useNow';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { quotaHistoryApi } from '@/services/api';
import { DAY_MS, HOUR_MS } from '@/utils/time/durations';
import { TYPE_COLORS } from '@/utils/quota';
import type { ResolvedTheme } from '@/types';
import {
  accountFromHistory,
  burnRatePerHour,
  historyByAccount,
  projectPool,
  recordedSeries,
  WEEK_HOURS,
} from '../quotaPoolModel';
import type {
  PoolAccount,
  PoolHistoryPoint,
  PoolResetMark,
  PoolSeriesPoint,
} from '../quotaPoolModel';
import type { QuotaFileEntry } from '../logic';
import type { QuotaCardState } from '../providers';
import styles from './QuotaPool.module.scss';

const POOL_PROVIDERS = [
  { type: 'claude', label: 'Claude', windowIds: ['seven-day'] },
  // Which slot carries the weekly limit depends on the plan; take the longest.
  { type: 'codex', label: 'Codex', windowIds: ['five-hour', 'weekly', 'monthly'] },
] as const;
const BURN_WINDOWS = [1, 3, 6] as const;
const HISTORY_DAYS = 30;
const HISTORY_REFRESH_MS = 2 * 60 * 1000;
/** Days of recorded history left of "now" in the current view. */
const DAYS_BEFORE_NOW = 3;
const SPAN_DAYS = 14;

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const formatAxisDay = (ms: number) => {
  const d = new Date(ms);
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()}`;
};
const formatShortDate = (ms: number) =>
  new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
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
  now: number
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
    window.periodHours && window.periodHours > 0 ? window.periodHours : WEEK_HOURS;
  const rolledOver = typeof window.resetAtMs === 'number' && window.resetAtMs <= now;
  return {
    name: entry.file.name,
    displayName,
    remaining: rolledOver ? 100 : Math.min(100, Math.max(0, 100 - window.usedPercent)),
    resetAtMs:
      typeof window.resetAtMs === 'number'
        ? rolledOver
          ? window.resetAtMs + periodHours * HOUR_MS
          : window.resetAtMs
        : null,
    periodHours,
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
  const [offset, setOffset] = useState(0);
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

  const startMs = useMemo(() => {
    const today = new Date(now);
    today.setHours(0, 0, 0, 0);
    return today.getTime() - DAYS_BEFORE_NOW * DAY_MS + offset * 7 * DAY_MS;
  }, [now, offset]);
  const endMs = startMs + SPAN_DAYS * DAY_MS;

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
        return { ...provider, total: providerEntries.length, accounts };
      }).filter((pool) => pool.total > 0),
    [entries, quotaFor, displayNameFor, history, now]
  );

  if (pools.length === 0) return null;

  return (
    <section className={styles.pool}>
      <div className={styles.controls}>
        <span className={styles.controlLabel}>Burn rate</span>
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
        {historyError && (
          <span className={styles.warning}>
            Quota history unavailable; showing live values only
          </span>
        )}
        <div className={styles.nav}>
          <span className={styles.range}>
            {formatShortDate(startMs)} to {formatShortDate(endMs - DAY_MS)}
          </span>
          <button type="button" aria-label="Previous week" onClick={() => setOffset((v) => v - 1)}>
            ‹
          </button>
          <button type="button" disabled={offset === 0} onClick={() => setOffset(0)}>
            Today
          </button>
          <button type="button" aria-label="Next week" onClick={() => setOffset((v) => v + 1)}>
            ›
          </button>
        </div>
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
          history={history}
          burnWindow={burnWindow}
          now={now}
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
  history: Map<string, PoolHistoryPoint[]>;
  burnWindow: number;
  now: number;
  startMs: number;
  endMs: number;
}

function PoolCard({
  label,
  color,
  totalAccounts,
  accounts,
  history,
  burnWindow,
  now,
  startMs,
  endMs,
}: PoolCardProps) {
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
  const projection = useMemo(
    () => projectPool(accounts, burn, now, projectionEnd),
    [accounts, burn, now, projectionEnd]
  );
  const nextReset = projection.resets[0] ?? null;

  const stats = [
    {
      label: 'Pool empty',
      value: projection.poolEmptyAt
        ? formatInstant(projection.poolEmptyAt)
        : `Not by ${formatShortDate(projectionEnd)}`,
    },
    {
      label: 'First empty',
      value: projection.firstEmpty
        ? `${projection.firstEmpty.name} in ${formatDuration(projection.firstEmpty.t - now)}`
        : `None by ${formatShortDate(projectionEnd)}`,
    },
    {
      label: 'Next reset',
      value: nextReset ? `+${formatPercent(nextReset.gain)} ${formatInstant(nextReset.t)}` : 'None',
    },
    { label: `Burn, last ${burnWindow}h`, value: `${burn.toFixed(1)}%/h` },
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
          now={now}
          startMs={startMs}
          endMs={endMs}
        />
      )}

      <footer className={styles.legend}>
        <span>Pool</span>
        <span className={styles.legendRecorded}>Recorded</span>
        <span className={styles.legendProjected}>Projected</span>
      </footer>
    </article>
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
  now: number;
  startMs: number;
  endMs: number;
}

function PoolChart({
  capacity,
  recorded,
  projected,
  resets,
  poolEmptyAt,
  now,
  startMs,
  endMs,
}: PoolChartProps) {
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
  const days = Array.from(
    { length: Math.round((endMs - startMs) / DAY_MS) },
    (_, i) => startMs + i * DAY_MS
  );
  const nowInView = inView(now);

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
          {days.map((day) => (
            <line
              key={day}
              className={styles.gridDay}
              x1={x(day)}
              x2={x(day)}
              y1={0}
              y2={CHART_H}
            />
          ))}
          <path className={styles.areaRecorded} d={area(recordedVisible)} />
          <path className={styles.areaProjected} d={area(projectedVisible)} />
          <path className={styles.lineRecorded} d={line(recordedVisible)} />
          <path className={styles.lineProjected} d={line(projectedVisible)} />
        </svg>

        {nowInView && (
          <div className={styles.now} style={{ left: `${pct(now)}%` }}>
            <span>Now</span>
          </div>
        )}
        {resets
          .filter((mark) => inView(mark.t))
          .map((mark) => (
            <span
              key={`${mark.t}-${mark.v}`}
              className={styles.resetLabel}
              style={{ left: `${pct(mark.t)}%`, top: `${(y(mark.v) / CHART_H) * 100}%` }}
            >
              +{formatPercent(mark.gain)}
            </span>
          ))}
        {poolEmptyAt !== null && inView(poolEmptyAt) && (
          <span className={styles.emptyLabel} style={{ left: `${pct(poolEmptyAt)}%` }}>
            Empty {formatInstant(poolEmptyAt)}
          </span>
        )}
        <div className={styles.xAxis}>
          {days.map((day) => (
            <span key={day} style={{ left: `${pct(day + DAY_MS / 2)}%` }}>
              {formatAxisDay(day)}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

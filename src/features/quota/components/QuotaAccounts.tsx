/**
 * Accounts at a glance: per subscription, how full its 5-hour and weekly windows are,
 * what the soonest-reset router does with it, and how many chats are on it.
 *
 * Thresholds mirror sdk/cliproxy/auth/selector_soonest_reset.go in the proxy fork.
 */

import type { CSSProperties } from 'react';
import type { ResolvedTheme } from '@/types';
import type { RoutingCandidate, RoutingSession } from '@/services/api';
import type { PoolHistoryPoint } from '@/features/quota/quotaPoolModel';
import { TYPE_COLORS } from '@/utils/quota';
import { accountProvider, shortAccountName } from '../accountNames';
import styles from './QuotaAccounts.module.scss';

/** New chats skip an account at this 5h usage. */
export const SHORT_SATURATION = 0.8;
/** Existing chats move off an account at this 5h usage. */
export const SHORT_DRAIN = 0.9;
/** The router treats an account's week as used up at this level. */
export const LONG_SATURATION = 0.97;
/** A chat counts as active when it sent a request this recently. */
const ACTIVE_MS = 30 * 60 * 1000;

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const formatInstant = (ms: number) =>
  `${WEEKDAYS[new Date(ms).getDay()]} ${new Date(ms).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  })}`;
const formatIn = (ms: number) => {
  const minutes = Math.max(0, Math.round(ms / 60000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ${minutes % 60}m` : `${Math.floor(hours / 24)}d ${hours % 24}h`;
};

type Tone = 'next' | 'ok' | 'warn' | 'bad' | 'muted';

interface AccountRow {
  file: string;
  provider: string;
  rank: number;
  candidate?: RoutingCandidate;
  point?: PoolHistoryPoint;
  chats: number;
  subagents: number;
}

export interface QuotaAccountsProps {
  queues: Record<string, RoutingCandidate[]>;
  sessions: RoutingSession[];
  latest: Map<string, PoolHistoryPoint>;
  now: number;
  resolvedTheme: ResolvedTheme;
}

export function QuotaAccounts({ queues, sessions, latest, now, resolvedTheme }: QuotaAccountsProps) {
  const rows: AccountRow[] = [];
  const seen = new Set<string>();
  Object.entries(queues).forEach(([provider, queue]) =>
    queue.forEach((candidate, rank) => {
      seen.add(candidate.auth);
      rows.push({ file: candidate.auth, provider, rank, candidate, chats: 0, subagents: 0 });
    })
  );
  latest.forEach((point, file) => {
    if (!seen.has(file)) rows.push({ file, provider: point.provider, rank: 99, chats: 0, subagents: 0 });
  });
  rows.forEach((row) => {
    row.point = latest.get(row.file);
    sessions.forEach((session) => {
      if (session.auth !== row.file || now - Date.parse(session.last_seen) > ACTIVE_MS) return;
      if (session.parent) row.subagents += 1;
      else row.chats += 1;
    });
  });

  if (rows.length === 0) return null;

  return (
    <section className={styles.accounts}>
      <header className={styles.head}>
        <h2 className={styles.title}>Accounts</h2>
        <span className={styles.hint}>
          New chats go to the account whose week resets soonest, skipping any at{' '}
          {SHORT_SATURATION * 100}% of its 5-hour window. At {SHORT_DRAIN * 100}%, chats move to another account.
        </span>
      </header>
      <div className={styles.list}>
        {rows.map((row) => (
          <AccountLine key={row.file} row={row} now={now} resolvedTheme={resolvedTheme} />
        ))}
      </div>
    </section>
  );
}

function AccountLine({ row, now, resolvedTheme }: { row: AccountRow; now: number; resolvedTheme: ResolvedTheme }) {
  const provider = row.provider || accountProvider(row.file);
  const colors = TYPE_COLORS[provider];
  const color = colors?.[resolvedTheme]?.text ?? colors?.light.text;
  const point = row.point;

  const shortReset = point?.short_reset ? point.short_reset * 1000 : undefined;
  const shortUsed =
    shortReset !== undefined && shortReset <= now
      ? 0
      : (point?.short_used ?? row.candidate?.short_usage ?? undefined);
  const longReset = point?.long_reset
    ? point.long_reset * 1000
    : row.candidate?.long_reset
      ? Date.parse(row.candidate.long_reset)
      : undefined;
  const longUsed = longReset !== undefined && longReset <= now ? 0 : point?.long_used;

  const status = accountStatus(row, shortUsed);
  const chatText =
    row.chats + row.subagents === 0
      ? 'no active chats'
      : [row.chats > 0 && `${row.chats} chat${row.chats === 1 ? '' : 's'}`, row.subagents > 0 && `${row.subagents} subagent${row.subagents === 1 ? '' : 's'}`]
          .filter(Boolean)
          .join(' + ');

  return (
    <article className={styles.account} style={{ '--account-color': color } as CSSProperties}>
      <div className={styles.identity} title={row.file}>
        <span className={styles.dot} aria-hidden="true" />
        <span className={styles.name}>{shortAccountName(row.file)}</span>
        <span className={styles.provider}>{provider}</span>
      </div>

      <Meter
        label="5 hours"
        used={shortUsed}
        warnAt={SHORT_SATURATION}
        badAt={SHORT_DRAIN}
        marks={[SHORT_SATURATION, SHORT_DRAIN]}
        caption={shortReset && shortReset > now ? `resets in ${formatIn(shortReset - now)}` : undefined}
      />
      <Meter
        label="Week"
        used={longUsed}
        warnAt={0.85}
        badAt={LONG_SATURATION}
        marks={[]}
        caption={longReset && longReset > now ? `resets ${formatInstant(longReset)}` : undefined}
      />

      <div className={styles.state}>
        <span className={styles.status} data-tone={status.tone}>
          {status.label}
        </span>
        <span className={styles.chats}>{chatText}</span>
      </div>
    </article>
  );
}

function Meter({
  label,
  used,
  warnAt,
  badAt,
  marks,
  caption,
}: {
  label: string;
  used: number | undefined;
  warnAt: number;
  badAt: number;
  marks: number[];
  caption?: string;
}) {
  const known = used !== undefined;
  const pct = known ? Math.min(100, Math.max(0, used * 100)) : 0;
  const tone = !known ? 'muted' : used >= badAt ? 'bad' : used >= warnAt ? 'warn' : 'ok';
  return (
    <div className={styles.meter}>
      <div className={styles.meterTop}>
        <span className={styles.meterLabel}>{label}</span>
        <span className={styles.meterValue}>{known ? `${Math.round(pct)}% used` : 'not seen yet'}</span>
      </div>
      <div className={styles.track}>
        <div className={styles.fill} data-tone={tone} style={{ width: `${pct}%` }} />
        {marks.map((mark) => (
          <span key={mark} className={styles.mark} style={{ left: `${mark * 100}%` }} />
        ))}
      </div>
      <span className={styles.caption}>{caption ?? ' '}</span>
    </div>
  );
}

/** What the router does with this account right now, in its own order of checks. */
function accountStatus(row: AccountRow, shortUsed: number | undefined): { label: string; tone: Tone } {
  const candidate = row.candidate;
  if (!candidate) return { label: 'Not in routing', tone: 'muted' };
  if (candidate.unavailable) {
    return {
      label: candidate.retry_after ? `Cooling down until ${formatInstant(Date.parse(candidate.retry_after))}` : 'Cooling down',
      tone: 'bad',
    };
  }
  if (shortUsed !== undefined && shortUsed >= SHORT_DRAIN) return { label: 'Chats moving off', tone: 'bad' };
  if (candidate.saturated) return { label: 'Skipped for new chats', tone: 'warn' };
  if (row.rank === 0) return { label: 'Gets the next new chat', tone: 'next' };
  if (!candidate.known) return { label: 'Quota not seen yet', tone: 'muted' };
  return { label: `Next in line #${row.rank + 1}`, tone: 'ok' };
}

/**
 * Live routing: the Accounts overview on top, then which account and model each chat is
 * on. Polls the proxy's routing activity and its latest quota observations.
 *
 * The proxy keeps chat activity in memory, so it starts empty after a proxy restart.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNow } from '@/hooks/useNow';
import { quotaHistoryApi, routingActivityApi } from '@/services/api';
import type { RoutingActivityResponse, RoutingSession } from '@/services/api';
import type { ResolvedTheme } from '@/types';
import type { PoolHistoryPoint } from '@/features/quota/quotaPoolModel';
import { shortAccountName } from '../accountNames';
import { QuotaAccounts } from './QuotaAccounts';
import styles from './QuotaRouting.module.scss';

const REFRESH_MS = 15 * 1000;
const HISTORY_WINDOW_MS = 6 * 60 * 60 * 1000;
/** Chats without a request for this long are hidden unless "show all" is on. */
const RECENT_MS = 2 * 60 * 60 * 1000;

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const formatInstant = (ms: number) =>
  `${WEEKDAYS[new Date(ms).getDay()]} ${new Date(ms).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  })}`;
const formatAgo = (ms: number) => {
  const minutes = Math.max(0, Math.round(ms / 60000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m ago`;
  return `${Math.floor(hours / 24)}d ago`;
};

export interface QuotaRoutingProps {
  resolvedTheme: ResolvedTheme;
}

interface ChatGroup {
  main: RoutingSession;
  subagents: RoutingSession[];
  lastSeen: number;
}

export function QuotaRouting({ resolvedTheme }: QuotaRoutingProps) {
  const now = useNow();
  const [data, setData] = useState<RoutingActivityResponse | null>(null);
  const [latest, setLatest] = useState<Map<string, PoolHistoryPoint>>(new Map());
  const [unavailable, setUnavailable] = useState(false);
  const [showAll, setShowAll] = useState(false);

  const load = useCallback(async () => {
    try {
      const [routing, history] = await Promise.all([
        routingActivityApi.get(),
        quotaHistoryApi.list(Date.now() - HISTORY_WINDOW_MS).catch(() => null),
      ]);
      setData(routing);
      if (history) {
        const byAuth = new Map<string, PoolHistoryPoint>();
        history.points.forEach((point) => {
          const prev = byAuth.get(point.auth);
          if (!prev || point.t >= prev.t) byAuth.set(point.auth, point);
        });
        setLatest(byAuth);
      }
      setUnavailable(false);
    } catch {
      setUnavailable(true);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  const groups = useMemo(() => groupChats(data?.sessions ?? []), [data]);

  if (unavailable && !data) return null;

  const visible = showAll ? groups : groups.filter((group) => now - group.lastSeen <= RECENT_MS);
  const hidden = groups.length - visible.length;

  return (
    <>
      <QuotaAccounts
        queues={data?.next ?? {}}
        sessions={data?.sessions ?? []}
        latest={latest}
        now={now}
        resolvedTheme={resolvedTheme}
      />
      <section className={styles.routing}>
        <header className={styles.head}>
          <h2 className={styles.title}>Chats</h2>
          <span className={styles.hint}>
            Which account each chat uses. Updates every 15s; starts empty after a proxy restart.
          </span>
          {(hidden > 0 || showAll) && (
            <button type="button" className={styles.more} onClick={() => setShowAll((v) => !v)}>
              {showAll ? 'Only the last 2 hours' : `Show ${hidden} older`}
            </button>
          )}
        </header>

        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Chat</th>
                <th>Account</th>
                <th>Model</th>
                <th className={styles.right}>Requests</th>
                <th className={styles.right}>Last active</th>
              </tr>
            </thead>
            <tbody>
              {visible.length === 0 ? (
                <tr>
                  <td colSpan={5} className={styles.empty}>
                    {groups.length === 0 ? 'No chats since the proxy started.' : 'No chats in the last 2 hours.'}
                  </td>
                </tr>
              ) : (
                visible.flatMap((group) => [
                  <SessionRow key={group.main.id} session={group.main} now={now} />,
                  ...group.subagents.map((sub) => (
                    <SessionRow key={sub.id} session={sub} now={now} nested />
                  )),
                ])
              )}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

/**
 * Main chats with their subagents under them, most recent first. A subagent whose parent
 * the proxy has not seen stands on its own.
 */
function groupChats(sessions: RoutingSession[]): ChatGroup[] {
  const ids = new Set(sessions.map((s) => s.id));
  const groups = new Map<string, ChatGroup>();
  sessions.forEach((session) => {
    if (session.parent && ids.has(session.parent)) return;
    groups.set(session.id, { main: session, subagents: [], lastSeen: Date.parse(session.last_seen) });
  });
  sessions.forEach((session) => {
    const group = session.parent ? groups.get(session.parent) : undefined;
    if (!group) return;
    group.subagents.push(session);
    group.lastSeen = Math.max(group.lastSeen, Date.parse(session.last_seen));
  });
  groups.forEach((group) => group.subagents.sort((a, b) => Date.parse(b.last_seen) - Date.parse(a.last_seen)));
  return [...groups.values()].sort((a, b) => b.lastSeen - a.lastSeen);
}

function SessionRow({ session, now, nested = false }: { session: RoutingSession; now: number; nested?: boolean }) {
  const otherModels = Object.keys(session.models ?? {}).filter((model) => model !== session.model);
  const switches = session.switches ?? [];
  const shortId = session.id.replace(/^[a-z-]+:/i, '').slice(0, 8);
  return (
    <tr data-nested={nested ? '1' : undefined}>
      <td>
        <div className={styles.chatTitle} title={session.title}>
          {nested && <span className={styles.branch}>↳ </span>}
          {session.title || `Session ${shortId}`}
        </div>
        <div className={styles.chatMeta}>
          {nested ? 'subagent' : session.client || session.provider} · {shortId}
        </div>
      </td>
      <td>
        <div title={session.auth}>{shortAccountName(session.auth)}</div>
        {switches.length > 0 && (
          <div
            className={styles.switched}
            title={switches
              .map(
                (s) =>
                  `${formatInstant(Date.parse(s.at))}: ${shortAccountName(s.from)} → ${shortAccountName(s.to)}`
              )
              .join('\n')}
          >
            moved {switches.length}×, last from {shortAccountName(switches[switches.length - 1].from)}
          </div>
        )}
      </td>
      <td>
        <div className={styles.model}>{session.model}</div>
        {otherModels.length > 0 && <div className={styles.chatMeta}>also {otherModels.join(', ')}</div>}
      </td>
      <td className={styles.num}>{session.requests}</td>
      <td className={styles.num}>{formatAgo(now - Date.parse(session.last_seen))}</td>
    </tr>
  );
}

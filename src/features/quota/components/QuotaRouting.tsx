/**
 * Routing activity: which credential and model each conversation is on, and which
 * credential the soonest-reset router will give the next new conversation.
 *
 * The proxy keeps this in memory, so it starts empty after a proxy restart.
 */

import { useCallback, useEffect, useState } from 'react';
import { useNow } from '@/hooks/useNow';
import { routingActivityApi } from '@/services/api';
import type { RoutingActivityResponse, RoutingCandidate, RoutingSession } from '@/services/api';
import styles from './QuotaRouting.module.scss';

const REFRESH_MS = 15 * 1000;
const MAX_ROWS = 30;
const PROVIDERS = [
  { type: 'claude', label: 'Claude' },
  { type: 'codex', label: 'Codex' },
] as const;

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
  displayNameFor: (name: string) => string;
}

export function QuotaRouting({ displayNameFor }: QuotaRoutingProps) {
  const now = useNow();
  const [data, setData] = useState<RoutingActivityResponse | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await routingActivityApi.get());
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

  if (unavailable && !data) return null;

  const queues = PROVIDERS.map((provider) => ({
    ...provider,
    queue: data?.next?.[provider.type] ?? [],
  })).filter((provider) => provider.queue.length > 0);
  const sessions = (data?.sessions ?? []).slice(0, MAX_ROWS);

  return (
    <section className={styles.routing}>
      <header className={styles.head}>
        <h2 className={styles.title}>Routing</h2>
        <span className={styles.hint}>Updates every 15s. Starts empty after a proxy restart.</span>
      </header>

      <div className={styles.queues}>
        {queues.map((provider) => (
          <div key={provider.type} className={styles.queue}>
            <span className={styles.queueLabel}>Next new {provider.label} chat</span>
            <ol>
              {provider.queue.map((candidate, index) => (
                <li key={candidate.auth} data-first={index === 0 ? '1' : undefined}>
                  <span className={styles.account}>{displayNameFor(candidate.auth)}</span>
                  <span className={styles.reason}>{candidateReason(candidate)}</span>
                </li>
              ))}
            </ol>
          </div>
        ))}
      </div>

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Chat</th>
              <th>Account</th>
              <th>Model</th>
              <th>Requests</th>
              <th>Last active</th>
            </tr>
          </thead>
          <tbody>
            {sessions.length === 0 ? (
              <tr>
                <td colSpan={5} className={styles.empty}>
                  No chats since the proxy started.
                </td>
              </tr>
            ) : (
              sessions.map((session) => (
                <SessionRow
                  key={session.id}
                  session={session}
                  now={now}
                  displayNameFor={displayNameFor}
                />
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** Why the router ranks a credential where it does, mirroring soonest-reset's order. */
function candidateReason(candidate: RoutingCandidate): string {
  if (candidate.unavailable) {
    return candidate.retry_after
      ? `cooling down until ${formatInstant(Date.parse(candidate.retry_after))}`
      : 'cooling down';
  }
  if (candidate.saturated) return 'nearly out, used last';
  if (!candidate.known) return 'no quota seen yet, probed first';
  return candidate.long_reset
    ? `week resets ${formatInstant(Date.parse(candidate.long_reset))}`
    : 'known quota';
}

function SessionRow({
  session,
  now,
  displayNameFor,
}: {
  session: RoutingSession;
  now: number;
  displayNameFor: (name: string) => string;
}) {
  const otherModels = Object.keys(session.models ?? {}).filter((model) => model !== session.model);
  const switches = session.switches ?? [];
  const shortId = session.id.replace(/^[a-z-]+:/i, '').slice(0, 8);
  return (
    <tr>
      <td>
        <div className={styles.chatTitle}>{session.title || `Session ${shortId}`}</div>
        <div className={styles.chatMeta}>
          {session.client || session.provider} · {shortId}
          {session.agent && <span className={styles.badge}>subagent</span>}
        </div>
      </td>
      <td>
        <div>{displayNameFor(session.auth)}</div>
        {switches.length > 0 && (
          <div
            className={styles.switched}
            title={switches
              .map(
                (s) =>
                  `${formatInstant(Date.parse(s.at))}: ${displayNameFor(s.from)} → ${displayNameFor(s.to)}`
              )
              .join('\n')}
          >
            switched {switches.length}×, last from{' '}
            {displayNameFor(switches[switches.length - 1].from)}
          </div>
        )}
      </td>
      <td>
        <div>{session.model}</div>
        {otherModels.length > 0 && (
          <div className={styles.chatMeta}>also {otherModels.join(', ')}</div>
        )}
      </td>
      <td className={styles.num}>{session.requests}</td>
      <td className={styles.num}>{formatAgo(now - Date.parse(session.last_seen))}</td>
    </tr>
  );
}

/**
 * Live routing: the Accounts overview, plus a pointer to the Chats page where each chat
 * can be read. Polls the proxy's routing activity and its latest quota observations.
 *
 * The proxy keeps chat activity in memory, so it starts empty after a proxy restart.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNow } from '@/hooks/useNow';
import { useTranslation } from 'react-i18next';
import { quotaHistoryApi, routingActivityApi } from '@/services/api';
import { Link } from 'react-router-dom';
import type { RoutingActivityResponse } from '@/services/api';
import type { ResolvedTheme } from '@/types';
import type { PoolHistoryPoint } from '@/features/quota/quotaPoolModel';
import { groupChats } from '@/features/chats/chatModel';
import { QuotaAccounts } from './QuotaAccounts';
import styles from './QuotaRouting.module.scss';

const REFRESH_MS = 15 * 1000;
const HISTORY_WINDOW_MS = 6 * 60 * 60 * 1000;
/** Chats with a request this recently are counted in the pointer to the Chats page. */
const RECENT_MS = 2 * 60 * 60 * 1000;

export interface QuotaRoutingProps {
  resolvedTheme: ResolvedTheme;
}

export function QuotaRouting({ resolvedTheme }: QuotaRoutingProps) {
  const now = useNow();
  const { t } = useTranslation();
  const [data, setData] = useState<RoutingActivityResponse | null>(null);
  const [latest, setLatest] = useState<Map<string, PoolHistoryPoint>>(new Map());
  const [unavailable, setUnavailable] = useState(false);

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

  const chatCount = useMemo(
    () =>
      groupChats(data?.sessions ?? []).filter((group) => now - group.lastSeen <= RECENT_MS).length,
    [data, now]
  );

  if (unavailable && !data) return null;

  return (
    <>
      {unavailable && <p role="status">{t('adaptive_routing.refresh_failed')}</p>}
      <QuotaAccounts
        queues={data?.next ?? {}}
        sessions={data?.sessions ?? []}
        latest={latest}
        now={now}
        resolvedTheme={resolvedTheme}
      />
      <p className={styles.chatsLink}>
        {chatCount > 0
          ? `${chatCount} chat${chatCount === 1 ? '' : 's'} in the last 2 hours. `
          : ''}
        <Link to="/chats">Open Chats</Link> to read them live.
      </p>
    </>
  );
}

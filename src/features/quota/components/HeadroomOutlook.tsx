/**
 * The expected periods without safe headroom, for the dashboard: the same list as under
 * the pool chart on the Quota page, computed from the quota history alone.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useNow } from '@/hooks/useNow';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { quotaHistoryApi, routingActivityApi } from '@/services/api';
import { DAY_MS } from '@/utils/time/durations';
import { shortAccountName } from '../accountNames';
import { headroomOutlook } from '../jointQuotaProjection';
import type { PoolHistoryPoint } from '../quotaPoolModel';
import { HeadroomEvents } from './QuotaPool';
import styles from './QuotaPool.module.scss';

const HISTORY_DAYS = 90;
const REFRESH_MS = 2 * 60 * 1000;

export function HeadroomOutlook() {
  const { t } = useTranslation();
  const now = useNow();
  // The same recent-pace setting as the pool chart, so both lists agree.
  const [burnWindow] = useLocalStorage<number>('quota-pool-burn-window', 3);
  const [points, setPoints] = useState<PoolHistoryPoint[] | null>(null);
  const [names, setNames] = useState<string[]>([]);
  const [unavailable, setUnavailable] = useState(false);

  const load = useCallback(async () => {
    try {
      const [routing, history] = await Promise.all([
        routingActivityApi.get(),
        quotaHistoryApi.list(Date.now() - HISTORY_DAYS * DAY_MS),
      ]);
      setNames((routing.next?.claude ?? []).map((candidate) => candidate.auth));
      setPoints(history.points ?? []);
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

  const outlook = useMemo(
    () => (points ? headroomOutlook(points, names, shortAccountName, burnWindow, now) : null),
    [points, names, burnWindow, now]
  );

  if (unavailable) return <p className={styles.note}>{t('quota_headroom.dashboard_unavailable')}</p>;
  if (points === null) return <p className={styles.note}>{t('quota_headroom.dashboard_loading')}</p>;
  if (!outlook) return <p className={styles.note}>{t('quota_headroom.dashboard_no_data')}</p>;
  return (
    <>
      <HeadroomEvents
        events={outlook.events}
        next={outlook.next}
        accounts={outlook.accounts}
        title={false}
      />
      <Link to="/quota" className={styles.eventsLink}>
        {t('quota_headroom.dashboard_link')}
      </Link>
    </>
  );
}

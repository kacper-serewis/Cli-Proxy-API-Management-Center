import { apiClient } from './client';
import type { PoolHistoryPoint } from '@/features/quota/quotaPoolModel';

export const quotaHistoryApi = {
  /** Quota observations recorded by the proxy at or after `sinceMs`. */
  list: (sinceMs: number) =>
    apiClient.get<{ points: PoolHistoryPoint[] }>('/observability/quota-history', {
      params: { since: Math.floor(sinceMs / 1000) },
    }),
};

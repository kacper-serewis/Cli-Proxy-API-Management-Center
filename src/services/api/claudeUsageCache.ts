import { apiClient } from './client';

/**
 * Claude usage as the proxy last read it (fork: GET /observability/claude-usage).
 * Anthropic rate-limits /api/oauth/usage per token over a short window, and the proxy
 * already reads it every 2 minutes for routing (with the banked reset grants included),
 * so the panel reads that copy instead of calling Anthropic itself. A forced read goes
 * through the proxy's single reader (POST .../refresh).
 */
export interface ClaudeUsageSnapshot {
  auth_id: string;
  auth_index: string;
  body?: unknown;
  observed_at?: string;
  last_attempt?: string;
  last_status?: number;
  backoff_until?: string;
}

/** A copy this young counts as current; the proxy polls every 2 minutes. */
export const CLAUDE_USAGE_FRESH_MS = 3 * 60_000;
const LIST_TTL_MS = 5_000;

type Deps = {
  list: () => Promise<{ accounts?: ClaudeUsageSnapshot[] }>;
  refresh: (authIndex: string) => Promise<ClaudeUsageSnapshot>;
  now: () => number;
};

const defaultDeps: Deps = {
  list: () => apiClient.get('/observability/claude-usage'),
  refresh: (authIndex) =>
    apiClient.post('/observability/claude-usage/refresh', { auth_index: authIndex }),
  now: () => Date.now(),
};

const ageMs = (snapshot: ClaudeUsageSnapshot | undefined, now: number) => {
  const at = snapshot?.observed_at ? Date.parse(snapshot.observed_at) : NaN;
  return Number.isFinite(at) ? now - at : Infinity;
};

/** The last read failed, so what is shown is older than it should be. */
export const isClaudeUsageStale = (snapshot: ClaudeUsageSnapshot) =>
  snapshot.last_status !== undefined && snapshot.last_status !== 200;

export function createClaudeUsageReader(deps: Deps = defaultDeps) {
  let listed: { at: number; promise: Promise<ClaudeUsageSnapshot[]> } | null = null;
  const list = () => {
    const now = deps.now();
    if (!listed || now - listed.at > LIST_TTL_MS) {
      const promise = deps.list().then((response) => response.accounts ?? []);
      listed = { at: now, promise };
      promise.catch(() => {
        if (listed?.promise === promise) listed = null;
      });
    }
    return listed.promise;
  };
  const refresh = async (authIndex: string) => {
    const snapshot = await deps.refresh(authIndex);
    listed = null;
    return snapshot;
  };
  return {
    /**
     * The proxy's copy when it is current or the proxy is backing off after a 429;
     * otherwise one read through the proxy now. `fresh` always reads (the proxy still
     * reuses a read from the last 10 seconds).
     */
    async read(authIndex: string, options: { fresh?: boolean } = {}) {
      if (options.fresh) return refresh(authIndex);
      const cached = (await list()).find((entry) => entry.auth_index === authIndex);
      const now = deps.now();
      const backingOff = cached?.backoff_until && Date.parse(cached.backoff_until) > now;
      if (cached?.body !== undefined && (ageMs(cached, now) <= CLAUDE_USAGE_FRESH_MS || backingOff)) {
        return cached;
      }
      return refresh(authIndex);
    },
  };
}

export const claudeUsageReader = createClaudeUsageReader();

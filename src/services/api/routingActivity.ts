import { apiClient } from './client';

export interface RoutingSwitch {
  at: string;
  from: string;
  to: string;
}

export interface RoutingSession {
  id: string;
  client?: string;
  agent?: string;
  parent?: string;
  title?: string;
  provider: string;
  auth: string;
  model: string;
  models: Record<string, number>;
  requests: number;
  first_seen: string;
  last_seen: string;
  switches?: RoutingSwitch[];
}

export interface RoutingCandidate {
  auth: string;
  known: boolean;
  long_reset?: string;
  short_usage: number;
  saturated: boolean;
  unavailable: boolean;
  retry_after?: string;
}

export interface RoutingActivityResponse {
  sessions: RoutingSession[];
  next: Record<string, RoutingCandidate[]>;
}

export const routingActivityApi = {
  /** Per-session credential bindings and the soonest-reset queue for new sessions. */
  get: () => apiClient.get<RoutingActivityResponse>('/observability/routing'),
};

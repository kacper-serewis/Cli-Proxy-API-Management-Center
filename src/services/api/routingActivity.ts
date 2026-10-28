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

export interface ReserveWindow {
  inactive: boolean;
  used: number;
  reset: string;
  reserve: number;
  spare: number;
  forecast: number;
  buffer: number;
  recent_rate: number;
  typical_rate: number;
  learning: boolean;
}

export interface AdaptiveDecision {
  home: boolean;
  fresh: boolean;
  observed_at: string;
  eligible: boolean;
  draining: boolean;
  score: number;
  band: number;
  reason: string;
  short?: ReserveWindow;
  long?: ReserveWindow;
}

export interface RoutingCandidate {
  adaptive?: AdaptiveDecision;
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
  /** Per-session credential bindings and the active strategy’s queue for new sessions. */
  get: () => apiClient.get<RoutingActivityResponse>('/observability/routing'),
};

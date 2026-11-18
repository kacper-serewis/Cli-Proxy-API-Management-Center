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
  /** How the client was started: cli, print (claude -p, codex exec), sdk, ide, app or other. */
  origin?: string;
  user_agent?: string;
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
  /** In its weekly reserve: new chats come here only when the other accounts are full. */
  reserved?: boolean;
  /** The Fable-only weekly window, when the account reports one. */
  fable_usage?: number;
  fable_reset?: string;
  /** Out of Fable: new Fable chats skip it, other models still go there. */
  fable_saturated?: boolean;
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

import { apiClient } from './client';

export interface ForkCommitFile {
  path: string;
  added: number;
  deleted: number;
}

export interface ForkCommit {
  sha: string;
  date: string;
  subject: string;
  files: ForkCommitFile[];
}

export interface ForkRepo {
  name: string;
  path: string;
  branch: string;
  head: string;
  base_tag: string;
  latest_tag: string;
  behind: number;
  pushed: boolean;
  dirty: boolean;
  origin: string;
  upstream: string;
  installed: { path: string; modified: string } | null;
  commits: ForkCommit[];
}

export type UpdateOutcome = 'up-to-date' | 'waiting-idle' | 'updated' | 'failed';

export interface UpdateRun {
  at: string;
  last_at?: string;
  count: number;
  component: 'proxy' | 'panel';
  outcome: UpdateOutcome;
  step: string | null;
  detail: string | null;
  from: string | null;
  to: string | null;
  tests?: string[];
  log_tail?: string;
}

export interface ForkService {
  label: string;
  pid: number | null;
  last_exit: number | null;
  plist: string | null;
}

export interface ForkTool {
  name: string;
  path: string;
  description: string;
  modified: string;
}

export interface ForkConfigChange {
  key: string;
  default: string | null;
  value: string | null;
}

export interface ForkStatusSnapshot {
  generated_at: string;
  repos: ForkRepo[];
  runs: UpdateRun[];
  services: ForkService[];
  tools: ForkTool[];
  config: {
    path: string;
    modified: string | null;
    changed: ForkConfigChange[];
    backups: { name: string; modified: string }[];
  };
}

export interface ForkStatusResponse {
  running: { version: string; commit: string; build_date: string };
  status: ForkStatusSnapshot | null;
}

export const forkStatusApi = {
  /** Fork commits, updater runs, services and changed settings, written by cliproxyapi-fork-status. */
  get: () => apiClient.get<ForkStatusResponse>('/observability/fork'),
};

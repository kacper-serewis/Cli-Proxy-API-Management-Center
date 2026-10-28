/**
 * Fork & updates: what this local setup changes on top of upstream CLIProxyAPI and its
 * panel, and how the hourly updaters fared. The data is a snapshot that the local
 * cliproxyapi-fork-status tool writes after every updater run; the proxy serves it.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { IconRefreshCw } from '@/components/ui/icons';
import { useNow } from '@/hooks/useNow';
import { forkStatusApi } from '@/services/api';
import type {
  ForkRepo,
  ForkStatusResponse,
  ForkStatusSnapshot,
  UpdateRun,
} from '@/services/api';
import styles from './ForkPage.module.scss';

const REFRESH_MS = 60 * 1000;
const RUN_ROWS = 40;

const REPO_LABELS: Record<string, string> = { proxy: 'Proxy', panel: 'Panel' };

const OUTCOME_LABELS: Record<UpdateRun['outcome'], string> = {
  'up-to-date': 'Up to date',
  'waiting-idle': 'Waiting for idle',
  updated: 'Updated',
  failed: 'Failed',
};

const STEP_LABELS: Record<string, string> = {
  preflight: 'checks',
  rebase: 'rebase',
  'fork-tests': 'fork tests',
  'upstream-tests': 'upstream tests',
  tests: 'tests',
  build: 'build',
  health: 'health check',
  install: 'install',
  push: 'push',
};

const formatTime = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });

const formatAgo = (ms: number) => {
  const minutes = Math.max(0, Math.round(ms / 60000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
};

export function ForkPage() {
  const now = useNow();
  const [data, setData] = useState<ForkStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await forkStatusApi.get());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  const status = data?.status ?? null;

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>Fork &amp; updates</h1>
          <p className={styles.subtitle}>
            {data ? `Running ${data.running.version} (${data.running.commit})` : 'Loading…'}
            {status && ` · snapshot ${formatAgo(now - Date.parse(status.generated_at))}`}
          </p>
        </div>
        <Button variant="secondary" size="sm" onClick={() => void load()} disabled={loading}>
          <IconRefreshCw size={14} /> Refresh
        </Button>
      </header>

      {error && !data && (
        <div className={styles.notice}>
          The proxy does not serve fork status yet ({error}). It needs a proxy build with
          <code> /v8/management/observability/fork</code>; the hourly updater installs it with
          the next upstream release.
        </div>
      )}
      {data && !status && (
        <div className={styles.notice}>
          No snapshot yet. Run <code>~/dev/cliproxyapi-tools/cliproxyapi-fork-status</code> or
          wait for the next hourly updater run.
        </div>
      )}

      {status && <ForkStatusView status={status} running={data!.running} now={now} />}
    </div>
  );
}

function ForkStatusView({
  status,
  running,
  now,
}: {
  status: ForkStatusSnapshot;
  running: ForkStatusResponse['running'];
  now: number;
}) {
  return (
    <>
      <div className={styles.repoGrid}>
        {status.repos.map((repo) => (
          <RepoCard
            key={repo.name}
            repo={repo}
            running={repo.name === 'proxy' ? running : null}
            lastRun={status.runs.find((run) => run.component === repo.name) ?? null}
            now={now}
          />
        ))}
      </div>
      <UpdateHistory runs={status.runs} />
      <Changes repos={status.repos} />
      <LocalSetup status={status} />
    </>
  );
}

/** One line on where a component stands, from its newest updater run. */
function runSummary(run: UpdateRun | null, now: number): { tone: string; text: string } {
  if (!run) return { tone: 'muted', text: 'No updater runs recorded yet' };
  const checked = formatAgo(now - Date.parse(run.last_at ?? run.at));
  switch (run.outcome) {
    case 'up-to-date':
      return { tone: 'ok', text: `Up to date, checked ${checked}` };
    case 'waiting-idle':
      return {
        tone: 'warn',
        text: `${run.to} is waiting for 15 minutes without model traffic (checked ${checked}, ${run.count}× so far)`,
      };
    case 'updated':
      return { tone: 'ok', text: `Updated ${run.from} → ${run.to} ${checked}` };
    case 'failed':
      return {
        tone: 'bad',
        text: `Update to ${run.to ?? 'latest'} failed at ${STEP_LABELS[run.step ?? ''] ?? run.step ?? 'an unknown step'} ${checked}`,
      };
  }
}

function RepoCard({
  repo,
  running,
  lastRun,
  now,
}: {
  repo: ForkRepo;
  running: ForkStatusResponse['running'] | null;
  lastRun: UpdateRun | null;
  now: number;
}) {
  const summary = runSummary(lastRun, now);
  const warnings = [
    repo.dirty && 'uncommitted changes in the checkout',
    !repo.pushed && 'branch not pushed to origin',
    running && !running.commit.startsWith(repo.head.slice(0, 7)) && 'running binary is not the branch head',
  ].filter(Boolean) as string[];
  return (
    <article className={styles.card}>
      <div className={styles.cardHead}>
        <h2 className={styles.cardTitle}>{REPO_LABELS[repo.name] ?? repo.name}</h2>
        <span className={styles.branch}>
          {repo.branch} @ {repo.head}
        </span>
      </div>
      <div className={styles.versionLine}>
        <span className={styles.version}>{repo.base_tag}</span>
        {repo.behind > 0 ? (
          <span className={styles.behind}>
            {repo.latest_tag} available · {repo.behind} commits behind
          </span>
        ) : (
          <span className={styles.current}>latest upstream release</span>
        )}
      </div>
      <div className={styles.summary} data-tone={summary.tone}>
        {summary.text}
      </div>
      {lastRun?.outcome === 'failed' && lastRun.detail && (
        <div className={styles.failDetail}>{lastRun.detail}</div>
      )}
      <dl className={styles.facts}>
        <dt>Our commits</dt>
        <dd>{repo.commits.length}</dd>
        {running && (
          <>
            <dt>Running</dt>
            <dd>
              {running.version} ({running.commit})
            </dd>
          </>
        )}
        {repo.installed && (
          <>
            <dt>Installed</dt>
            <dd title={repo.installed.path}>{formatTime(repo.installed.modified)}</dd>
          </>
        )}
      </dl>
      {warnings.length > 0 && (
        <ul className={styles.warnings}>
          {warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}
    </article>
  );
}

function UpdateHistory({ runs }: { runs: UpdateRun[] }) {
  const [showQuiet, setShowQuiet] = useState(false);
  const rows = useMemo(
    () =>
      runs
        .filter((run) => showQuiet || run.outcome === 'failed' || run.outcome === 'updated' || run.outcome === 'waiting-idle')
        .slice(0, RUN_ROWS),
    [runs, showQuiet]
  );
  return (
    <section className={styles.section}>
      <header className={styles.sectionHead}>
        <h2 className={styles.sectionTitle}>Updater runs</h2>
        <span className={styles.hint}>Hourly. Repeated checks with the same result are folded into one row.</span>
        <label className={styles.toggle}>
          <input type="checkbox" checked={showQuiet} onChange={(e) => setShowQuiet(e.target.checked)} />
          Show “up to date” checks
        </label>
      </header>
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>When</th>
              <th>Part</th>
              <th>Result</th>
              <th>Version</th>
              <th>Why</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={5} className={styles.empty}>
                  No runs recorded.
                </td>
              </tr>
            ) : (
              rows.map((run) => <RunRow key={`${run.component}-${run.at}`} run={run} />)
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function RunRow({ run }: { run: UpdateRun }) {
  const version = run.from && run.to && run.from !== run.to ? `${run.from} → ${run.to}` : (run.to ?? run.from ?? '');
  return (
    <tr>
      <td className={styles.nowrap}>
        {formatTime(run.at)}
        {run.count > 1 && run.last_at && (
          <div className={styles.meta}>
            {run.count}× until {formatTime(run.last_at)}
          </div>
        )}
      </td>
      <td>{REPO_LABELS[run.component] ?? run.component}</td>
      <td>
        <span className={styles.chip} data-outcome={run.outcome}>
          {OUTCOME_LABELS[run.outcome]}
        </span>
      </td>
      <td className={styles.nowrap}>{version}</td>
      <td>
        {run.outcome === 'failed' && run.step && (
          <div className={styles.step}>at {STEP_LABELS[run.step] ?? run.step}</div>
        )}
        {run.detail && <div className={styles.detail}>{run.detail}</div>}
        {run.tests && run.tests.length > 0 && (
          <div className={styles.tests}>
            {run.tests.map((test) => (
              <code key={test}>{test}</code>
            ))}
          </div>
        )}
        {run.log_tail && (
          <details className={styles.log}>
            <summary>Test output</summary>
            <pre>{run.log_tail}</pre>
          </details>
        )}
      </td>
    </tr>
  );
}

function Changes({ repos }: { repos: ForkRepo[] }) {
  return (
    <section className={styles.section}>
      <header className={styles.sectionHead}>
        <h2 className={styles.sectionTitle}>Our changes</h2>
        <span className={styles.hint}>
          Commits on our fork branches on top of the upstream release. The updaters rebase them onto each new release.
        </span>
      </header>
      {repos.map((repo) => (
        <div key={repo.name} className={styles.repoChanges}>
          <h3 className={styles.repoTitle}>
            {REPO_LABELS[repo.name] ?? repo.name}
            <span className={styles.meta}>
              {' '}
              {repo.commits.length} commits on {repo.base_tag} ·{' '}
              <a href={repo.origin.replace(/\.git$/, '')} target="_blank" rel="noreferrer">
                {repo.origin.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '')}
              </a>
            </span>
          </h3>
          <ol className={styles.commits}>
            {repo.commits
              .slice()
              .reverse()
              .map((commit) => {
                const added = commit.files.reduce((sum, file) => sum + file.added, 0);
                const deleted = commit.files.reduce((sum, file) => sum + file.deleted, 0);
                return (
                  <li key={commit.sha}>
                    <details>
                      <summary>
                        <span className={styles.subject}>{commit.subject}</span>
                        <span className={styles.meta}>
                          {commit.sha} · {formatTime(commit.date)} · {commit.files.length} files ·{' '}
                          <span className={styles.added}>+{added}</span>{' '}
                          <span className={styles.deleted}>−{deleted}</span>
                        </span>
                      </summary>
                      <ul className={styles.files}>
                        {commit.files.map((file) => (
                          <li key={file.path}>
                            <code>{file.path}</code>
                            <span className={styles.added}>+{file.added}</span>
                            <span className={styles.deleted}>−{file.deleted}</span>
                          </li>
                        ))}
                      </ul>
                    </details>
                  </li>
                );
              })}
          </ol>
        </div>
      ))}
    </section>
  );
}

function LocalSetup({ status }: { status: ForkStatusSnapshot }) {
  return (
    <section className={styles.section}>
      <header className={styles.sectionHead}>
        <h2 className={styles.sectionTitle}>Local setup</h2>
        <span className={styles.hint}>Services, scripts and settings this setup adds outside the forks.</span>
      </header>
      <div className={styles.setupGrid}>
        <div>
          <h3 className={styles.repoTitle}>Services</h3>
          <table className={styles.table}>
            <tbody>
              {status.services.map((service) => {
                const scheduled = service.label.endsWith('-update');
                const state = service.pid
                  ? `running (pid ${service.pid})`
                  : scheduled
                    ? 'scheduled hourly'
                    : 'not running';
                const bad = !service.pid && !scheduled;
                return (
                  <tr key={service.label}>
                    <td>
                      <code>{service.label}</code>
                    </td>
                    <td className={bad ? styles.bad : undefined}>{state}</td>
                    <td className={styles.meta}>
                      {service.last_exit ? `last exit ${service.last_exit}` : ''}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div>
          <h3 className={styles.repoTitle}>Scripts in ~/dev/cliproxyapi-tools</h3>
          <table className={styles.table}>
            <tbody>
              {status.tools.map((tool) => (
                <tr key={tool.name}>
                  <td>
                    <code>{tool.name}</code>
                    <div className={styles.meta}>{tool.description}</div>
                  </td>
                  <td className={styles.nowrap}>{formatTime(tool.modified)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div>
        <h3 className={styles.repoTitle}>
          Settings changed from the default
          <span className={styles.meta}> {status.config.path}</span>
        </h3>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Setting</th>
              <th>Default</th>
              <th>Ours</th>
            </tr>
          </thead>
          <tbody>
            {status.config.changed.map((change) => (
              <tr key={change.key}>
                <td>
                  <code>{change.key}</code>
                </td>
                <td className={styles.meta}>{change.default ?? 'not set'}</td>
                <td>
                  <code>{change.value ?? 'removed'}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {status.config.backups.length > 0 && (
          <p className={styles.meta}>
            Backups: {status.config.backups.map((backup) => backup.name).join(', ')}
          </p>
        )}
      </div>
    </section>
  );
}

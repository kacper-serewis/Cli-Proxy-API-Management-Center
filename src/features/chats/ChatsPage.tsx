/**
 * Chats: every conversation going through the proxy. The left column lists the chats (with
 * their subagents); the right shows either a live feed of the newest messages across all
 * chats or the full conversation of one chat, both updating while they stream.
 *
 * The proxy keeps conversations in memory only, so this starts empty after a restart.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { chatsApi, routingActivityApi } from '@/services/api';
import type {
  ChatBlock,
  ChatFeedResponse,
  ChatMessage,
  ChatTranscriptResponse,
  RoutingSession,
} from '@/services/api';
import { shortAccountName } from '@/features/quota/accountNames';
import {
  formatAgo,
  formatClock,
  groupChats,
  messageKind,
  oneLine,
  sessionLabel,
  shortSessionId,
  toolSummary,
  visibleBlocks,
  type BlockFilter,
} from './chatModel';
import styles from './ChatsPage.module.scss';

const SESSIONS_MS = 5_000;
const FEED_MS = 2_500;
const TRANSCRIPT_MS = 2_000;
/** Chats without a request for this long are hidden unless "show older" is on. */
const RECENT_MS = 2 * 60 * 60 * 1000;
/** A chat counts as active while it had a request this recently. */
const ACTIVE_MS = 60 * 1000;
const FILTER_KEY = 'chats.filter';

const ROLE_LABELS = { user: 'You', assistant: 'Agent', tool: 'Tool output', system: 'Context' };

function loadFilter(): BlockFilter {
  try {
    const raw = window.localStorage.getItem(FILTER_KEY);
    if (raw) return { tools: true, thinking: false, context: false, ...JSON.parse(raw) };
  } catch {
    // storage unavailable
  }
  return { tools: true, thinking: false, context: false };
}

/** Polls `fn` every `ms` while mounted, skipping a tick while the previous call runs. */
function usePoll(fn: () => Promise<void>, ms: number) {
  useEffect(() => {
    let busy = false;
    let stopped = false;
    const tick = async () => {
      if (busy || stopped) return;
      busy = true;
      try {
        await fn();
      } finally {
        busy = false;
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), ms);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [fn, ms]);
}

/** Re-render every few seconds so "ago" labels stay current. */
function useTick(ms = 5_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(timer);
  }, [ms]);
  return now;
}

export function ChatsPage() {
  const now = useTick();
  const [params, setParams] = useSearchParams();
  const selected = params.get('chat');
  const [sessions, setSessions] = useState<RoutingSession[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [showOlder, setShowOlder] = useState(false);
  const [filter, setFilter] = useState<BlockFilter>(loadFilter);

  const loadSessions = useCallback(async () => {
    try {
      const data = await routingActivityApi.get();
      setSessions(data.sessions ?? []);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);
  usePoll(loadSessions, SESSIONS_MS);

  const updateFilter = (patch: Partial<BlockFilter>) =>
    setFilter((prev) => {
      const next = { ...prev, ...patch };
      try {
        window.localStorage.setItem(FILTER_KEY, JSON.stringify(next));
      } catch {
        // storage unavailable
      }
      return next;
    });

  const select = (id: string | null) => {
    const next = new URLSearchParams(params);
    if (id) next.set('chat', id);
    else next.delete('chat');
    setParams(next, { replace: false });
  };

  const byId = useMemo(() => new Map((sessions ?? []).map((s) => [s.id, s])), [sessions]);
  const groups = useMemo(() => groupChats(sessions ?? []), [sessions]);
  const visible = showOlder ? groups : groups.filter((g) => now - g.lastSeen <= RECENT_MS);
  const hidden = groups.length - visible.length;
  const activeCount = groups.filter((g) => now - g.lastSeen <= ACTIVE_MS).length;

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>Chats</h1>
          <p className={styles.subtitle}>
            What every chat through the proxy says, live. Kept in memory only, so this starts empty
            after a proxy restart.
          </p>
        </div>
        <div className={styles.filters} role="group" aria-label="Show in conversations">
          <Toggle
            label="Tool calls"
            on={filter.tools}
            onChange={(tools) => updateFilter({ tools })}
          />
          <Toggle
            label="Thinking"
            on={filter.thinking}
            onChange={(thinking) => updateFilter({ thinking })}
          />
          <Toggle
            label="Context"
            on={filter.context}
            onChange={(context) => updateFilter({ context })}
          />
        </div>
      </header>

      {failed && <p className={styles.notice}>Could not reach the proxy; retrying.</p>}

      <div className={styles.layout}>
        <nav className={styles.list} aria-label="Chats">
          <button
            type="button"
            className={styles.listItem}
            data-selected={selected === null ? '1' : undefined}
            onClick={() => select(null)}
          >
            <span className={styles.listTitle}>
              <span className={styles.liveDot} data-on={activeCount > 0 ? '1' : undefined} />
              All chats, live
            </span>
            <span className={styles.listMeta}>
              {activeCount > 0 ? `${activeCount} active now` : 'newest messages first'}
            </span>
          </button>

          {sessions !== null && visible.length === 0 && (
            <p className={styles.listEmpty}>
              {groups.length === 0
                ? 'No chats since the proxy started.'
                : 'No chats in the last 2 hours.'}
            </p>
          )}

          {visible.map((group) => (
            <div key={group.main.id}>
              <ChatListItem
                session={group.main}
                now={now}
                selected={selected === group.main.id}
                onSelect={select}
              />
              {group.subagents.map((sub) => (
                <ChatListItem
                  key={sub.id}
                  session={sub}
                  now={now}
                  selected={selected === sub.id}
                  onSelect={select}
                  nested
                />
              ))}
            </div>
          ))}

          {(hidden > 0 || showOlder) && (
            <button type="button" className={styles.more} onClick={() => setShowOlder((v) => !v)}>
              {showOlder ? 'Only the last 2 hours' : `Show ${hidden} older`}
            </button>
          )}
        </nav>

        <section className={styles.pane}>
          {selected ? (
            <TranscriptView
              key={selected}
              id={selected}
              session={byId.get(selected)}
              filter={filter}
              now={now}
              onBack={() => select(null)}
            />
          ) : (
            <FeedView filter={filter} onSelect={select} now={now} />
          )}
        </section>
      </div>
    </div>
  );
}

function Toggle({
  label,
  on,
  onChange,
}: {
  label: string;
  on: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <button type="button" className={styles.toggle} aria-pressed={on} onClick={() => onChange(!on)}>
      {label}
    </button>
  );
}

function ChatListItem({
  session,
  now,
  selected,
  onSelect,
  nested = false,
}: {
  session: RoutingSession;
  now: number;
  selected: boolean;
  onSelect: (id: string) => void;
  nested?: boolean;
}) {
  const active = now - Date.parse(session.last_seen) <= ACTIVE_MS;
  return (
    <button
      type="button"
      className={styles.listItem}
      data-selected={selected ? '1' : undefined}
      data-nested={nested ? '1' : undefined}
      onClick={() => onSelect(session.id)}
      title={session.title}
    >
      <span className={styles.listTitle}>
        <span className={styles.liveDot} data-on={active ? '1' : undefined} />
        {nested && <span className={styles.branch}>↳</span>}
        <span className={styles.ellipsis}>{sessionLabel(session, session.id)}</span>
      </span>
      <span className={styles.listMeta}>
        {shortAccountName(session.auth)} · {session.model.replace(/^claude-/, '')} ·{' '}
        {formatAgo(now - Date.parse(session.last_seen))}
      </span>
    </button>
  );
}

function FeedView({
  filter,
  onSelect,
  now,
}: {
  filter: BlockFilter;
  onSelect: (id: string) => void;
  now: number;
}) {
  const [feed, setFeed] = useState<ChatFeedResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(async () => {
    try {
      setFeed(await chatsApi.feed(80, filter.tools));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [filter.tools]);
  usePoll(load, FEED_MS);

  if (!feed) {
    return <p className={styles.paneEmpty}>{failed ? 'Could not load the feed.' : 'Loading…'}</p>;
  }
  if (feed.items.length === 0) {
    return (
      <p className={styles.paneEmpty}>
        No messages yet. They appear here as soon as a chat sends its next request.
      </p>
    );
  }
  return (
    <ol className={styles.feed}>
      {feed.items.map((item) => {
        const session = feed.sessions[item.session_id];
        return (
          <li key={`${item.session_id}:${item.message.seq}`} className={styles.feedItem}>
            <button
              type="button"
              className={styles.feedChat}
              onClick={() => onSelect(item.session_id)}
              title="Open this chat"
            >
              <span className={styles.ellipsis}>{sessionLabel(session, item.session_id)}</span>
              {session && (
                <span className={styles.feedChatMeta}>
                  {session.parent ? 'subagent · ' : ''}
                  {shortAccountName(session.auth)}
                </span>
              )}
            </button>
            <MessageView message={item.message} filter={filter} now={now} clamp />
          </li>
        );
      })}
    </ol>
  );
}

function TranscriptView({
  id,
  session,
  filter,
  now,
  onBack,
}: {
  id: string;
  session: RoutingSession | undefined;
  filter: BlockFilter;
  now: number;
  onBack: () => void;
}) {
  const [data, setData] = useState<ChatTranscriptResponse | null>(null);
  const [missing, setMissing] = useState(false);
  const version = useRef<number | undefined>(undefined);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const load = useCallback(async () => {
    try {
      const res = await chatsApi.transcript(id, version.current);
      if ('unchanged' in res) return;
      version.current = res.version;
      setData(res);
      setMissing(false);
    } catch {
      setMissing(true);
    }
  }, [id]);
  usePoll(load, TRANSCRIPT_MS);

  const onScroll = () => {
    const el = scroller.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [data, filter]);

  const info = data?.session ?? session;
  const messages = (data?.messages ?? []).filter(
    (m) => visibleBlocks(m.blocks, filter).length > 0 || m.live
  );

  return (
    <div className={styles.transcript}>
      <header className={styles.transcriptHead}>
        <button type="button" className={styles.back} onClick={onBack}>
          ← All chats
        </button>
        <h2 className={styles.transcriptTitle} title={info?.title}>
          {sessionLabel(info, id)}
        </h2>
        {info && (
          <p className={styles.transcriptMeta}>
            {info.parent ? 'subagent · ' : ''}
            {shortAccountName(info.auth)} · {info.model} · {info.requests} requests · last{' '}
            {formatAgo(now - Date.parse(info.last_seen))} · {shortSessionId(id)}
          </p>
        )}
      </header>
      <div className={styles.transcriptBody} ref={scroller} onScroll={onScroll}>
        {data && data.omitted > 0 && (
          <p className={styles.omitted}>{data.omitted} earlier messages not kept by the proxy</p>
        )}
        {!data && (
          <p className={styles.paneEmpty}>
            {missing
              ? 'The proxy has no conversation for this chat (it may predate the last restart).'
              : 'Loading…'}
          </p>
        )}
        {data && messages.length === 0 && (
          <p className={styles.paneEmpty}>
            No conversation kept yet; it appears with this chat’s next request.
          </p>
        )}
        {messages.map((message) => (
          <MessageView key={message.seq} message={message} filter={filter} now={now} />
        ))}
      </div>
    </div>
  );
}

function MessageView({
  message,
  filter,
  now,
  clamp = false,
}: {
  message: ChatMessage;
  filter: BlockFilter;
  now: number;
  clamp?: boolean;
}) {
  const kind = messageKind(message);
  const blocks = visibleBlocks(message.blocks, filter);
  const at = Date.parse(message.at);
  return (
    <article className={styles.message} data-kind={kind}>
      <div className={styles.messageHead}>
        <span className={styles.role}>{ROLE_LABELS[kind]}</span>
        {message.live && <span className={styles.streaming}>typing…</span>}
        <span className={styles.time} title={new Date(at).toLocaleString()}>
          {now - at < 60 * 60 * 1000 ? formatAgo(now - at) : formatClock(message.at)}
        </span>
      </div>
      {blocks.map((block, i) => (
        <BlockView key={i} block={block} clamp={clamp} />
      ))}
    </article>
  );
}

function BlockView({ block, clamp }: { block: ChatBlock; clamp: boolean }) {
  const [open, setOpen] = useState(false);
  const cut = block.truncated ? <span className={styles.cut}> … (shortened)</span> : null;
  switch (block.kind) {
    case 'text':
      return (
        <div
          className={styles.text}
          data-clamp={clamp && !open ? '1' : undefined}
          onClick={clamp && !open ? () => setOpen(true) : undefined}
        >
          {block.text}
          {cut}
        </div>
      );
    case 'image':
      return <div className={styles.image}>[{block.name || 'image'}]</div>;
    case 'tool_use':
      return (
        <Collapsible
          label={block.name || 'tool'}
          summary={toolSummary(block)}
          className={styles.tool}
        >
          {block.text}
          {cut}
        </Collapsible>
      );
    case 'tool_result':
      return (
        <Collapsible
          label={block.error ? 'error' : 'result'}
          summary={oneLine(block.text ?? '')}
          className={styles.result}
          error={block.error}
        >
          {block.text}
          {cut}
        </Collapsible>
      );
    case 'thinking':
      return (
        <Collapsible
          label="thinking"
          summary={oneLine(block.text ?? '')}
          className={styles.thinking}
        >
          {block.text}
          {cut}
        </Collapsible>
      );
    default:
      return (
        <Collapsible
          label={block.name || 'context'}
          summary={oneLine(block.text ?? '')}
          className={styles.context}
        >
          {block.text}
          {cut}
        </Collapsible>
      );
  }
}

function Collapsible({
  label,
  summary,
  className,
  error = false,
  children,
}: {
  label: string;
  summary: string;
  className: string;
  error?: boolean;
  children: React.ReactNode;
}) {
  return (
    <details className={`${styles.block} ${className}`} data-error={error ? '1' : undefined}>
      <summary>
        <span className={styles.blockLabel}>{label}</span>
        <span className={styles.blockSummary}>{summary}</span>
      </summary>
      <pre className={styles.pre}>{children}</pre>
    </details>
  );
}

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
  groupMatchesOrigin,
  looksLikeJson,
  prettyJson,
  splitJson,
  tokenizeJson,
  originFilter,
  originLabel,
  ORIGIN_FILTERS,
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
  // The selection lives in state and is only mirrored to the URL: the panel's page
  // transition keeps rendering a page with the location it opened on until the path
  // changes, so this page never sees later ?chat= / ?origin= changes through the router.
  const [params, setParams] = useSearchParams();
  const [selected, setSelected] = useState<string | null>(() => params.get('chat'));
  const [originKey, setOriginKey] = useState<string | null>(() => params.get('origin'));
  const origin = originFilter(originKey);
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

  const mirror = (chat: string | null, originParam: string | null) => {
    const next = new URLSearchParams();
    if (chat) next.set('chat', chat);
    if (originParam) next.set('origin', originParam);
    setParams(next, { replace: true });
  };
  const select = (id: string | null) => {
    setSelected(id);
    mirror(id, originKey);
  };
  const chooseOrigin = (key: string | null) => {
    setOriginKey(key);
    mirror(selected, key);
  };

  const byId = useMemo(() => new Map((sessions ?? []).map((s) => [s.id, s])), [sessions]);
  const allGroups = useMemo(() => groupChats(sessions ?? []), [sessions]);
  const inRange = (g: (typeof allGroups)[number]) => showOlder || now - g.lastSeen <= RECENT_MS;
  const groups = allGroups.filter((g) => groupMatchesOrigin(g, origin));
  const visible = groups.filter(inRange);
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
          <div className={styles.originFilters} role="group" aria-label="Started as">
            {ORIGIN_FILTERS.map((f) => {
              const count = allGroups.filter((g) => inRange(g) && groupMatchesOrigin(g, f)).length;
              return (
                <button
                  key={f.key}
                  type="button"
                  className={styles.toggle}
                  aria-pressed={f.key === origin.key}
                  onClick={() => chooseOrigin(f.key === 'all' ? null : f.key)}
                >
                  {f.label}
                  {sessions !== null && <span className={styles.count}>{count}</span>}
                </button>
              );
            })}
          </div>
          <button
            type="button"
            className={styles.listItem}
            data-selected={selected === null ? '1' : undefined}
            onClick={() => select(null)}
          >
            <span className={styles.listTitle}>
              <span className={styles.liveDot} data-on={activeCount > 0 ? '1' : undefined} />
              {origin.key === 'all' ? 'All chats, live' : `All ${origin.label} chats, live`}
            </span>
            <span className={styles.listMeta}>
              {activeCount > 0 ? `${activeCount} active now` : 'newest messages first'}
            </span>
          </button>

          {sessions !== null && visible.length === 0 && (
            <p className={styles.listEmpty}>
              {groups.length === 0
                ? origin.key === 'all'
                  ? 'No chats since the proxy started.'
                  : `No ${origin.label} chats since the proxy started.`
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
            <FeedView filter={filter} origins={origin.origins} onSelect={select} now={now} />
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
        {!nested && originLabel(session) && <>{originLabel(session)} · </>}
        {shortAccountName(session.auth)} · {session.model.replace(/^claude-/, '')} ·{' '}
        {formatAgo(now - Date.parse(session.last_seen))}
      </span>
    </button>
  );
}

function FeedView({
  filter,
  origins,
  onSelect,
  now,
}: {
  filter: BlockFilter;
  origins: string[];
  onSelect: (id: string) => void;
  now: number;
}) {
  const [feed, setFeed] = useState<ChatFeedResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(async () => {
    try {
      setFeed(await chatsApi.feed(80, filter.tools, origins));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [filter.tools, origins]);
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
                  {session.parent
                    ? 'subagent · '
                    : originLabel(session)
                      ? `${originLabel(session)} · `
                      : ''}
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
            {info.parent ? 'subagent · ' : originLabel(info) ? `${originLabel(info)} · ` : ''}
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
      return <TextBlock block={block} clamp={clamp} cut={cut} />;
    case 'image':
      return <div className={styles.image}>[{block.name || 'image'}]</div>;
    case 'tool_use':
      return (
        <Collapsible
          label={block.name || 'tool'}
          summary={toolSummary(block)}
          className={styles.tool}
          open={open}
          onToggle={setOpen}
        >
          {open && <MaybeJson block={block} />}
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
          open={open}
          onToggle={setOpen}
        >
          {open && <MaybeJson block={block} />}
          {cut}
        </Collapsible>
      );
    default:
      return (
        <Collapsible
          label={block.kind === 'thinking' ? 'thinking' : block.name || 'context'}
          summary={oneLine(block.text ?? '')}
          className={block.kind === 'thinking' ? styles.thinking : styles.context}
          open={open}
          onToggle={setOpen}
        >
          {open && <MaybeJson block={block} />}
          {cut}
        </Collapsible>
      );
  }
}

/** Prose as written; a JSON part of it indented and highlighted. */
function TextBlock({
  block,
  clamp,
  cut,
}: {
  block: ChatBlock;
  clamp: boolean;
  cut: React.ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const text = block.text ?? '';
  const { prose, json } = useMemo(() => splitJson(text, block.truncated), [text, block.truncated]);
  const clamped = clamp && !expanded;
  return (
    <>
      {(prose || !json) && (
        <div
          className={styles.text}
          data-clamp={clamped ? '1' : undefined}
          onClick={clamped ? () => setExpanded(true) : undefined}
        >
          {prose}
          {!json && cut}
        </div>
      )}
      {json && (
        <JsonView json={json} compact={clamped} onExpand={() => setExpanded(true)}>
          {cut}
        </JsonView>
      )}
    </>
  );
}

/** Tool input/output and context: JSON indented when it is JSON, otherwise as is. */
function MaybeJson({ block }: { block: ChatBlock }) {
  const text = block.text ?? '';
  const json = useMemo(() => looksLikeJson(text, block.truncated), [text, block.truncated]);
  return json ? <JsonTokens json={text} /> : <>{text}</>;
}

function JsonView({
  json,
  compact,
  onExpand,
  children,
}: {
  json: string;
  compact: boolean;
  onExpand: () => void;
  children?: React.ReactNode;
}) {
  return (
    <pre
      className={`${styles.pre} ${styles.json}`}
      data-compact={compact ? '1' : undefined}
      onClick={compact ? onExpand : undefined}
      title={compact ? 'Click to show all' : undefined}
    >
      <JsonTokens json={json} />
      {children}
    </pre>
  );
}

function JsonTokens({ json }: { json: string }) {
  const tokens = useMemo(() => tokenizeJson(prettyJson(json)), [json]);
  return (
    <>
      {tokens.map((token, i) =>
        token.kind ? (
          <span key={i} className={styles[`json_${token.kind}`]}>
            {token.text}
          </span>
        ) : (
          token.text
        )
      )}
    </>
  );
}

function Collapsible({
  label,
  summary,
  className,
  error = false,
  open,
  onToggle,
  children,
}: {
  label: string;
  summary: string;
  className: string;
  error?: boolean;
  open: boolean;
  onToggle: (open: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <details
      className={`${styles.block} ${className}`}
      data-error={error ? '1' : undefined}
      open={open}
      onToggle={(event) => onToggle(event.currentTarget.open)}
    >
      <summary>
        <span className={styles.blockLabel}>{label}</span>
        <span className={styles.blockSummary}>{summary}</span>
      </summary>
      <pre className={styles.pre}>{children}</pre>
    </details>
  );
}

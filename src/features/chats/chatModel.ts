/**
 * Pure helpers for the Chats page: grouping chats with their subagents, and short
 * summaries of tool calls so a transcript reads like a conversation.
 */

import type { ChatBlock, ChatMessage, RoutingSession } from '@/services/api';

export interface ChatGroup {
  main: RoutingSession;
  subagents: RoutingSession[];
  lastSeen: number;
}

/**
 * Main chats with their subagents under them, most recent first. A subagent whose parent
 * the proxy has not seen stands on its own.
 */
export function groupChats(sessions: RoutingSession[]): ChatGroup[] {
  const ids = new Set(sessions.map((s) => s.id));
  const groups = new Map<string, ChatGroup>();
  sessions.forEach((session) => {
    if (session.parent && ids.has(session.parent)) return;
    groups.set(session.id, {
      main: session,
      subagents: [],
      lastSeen: Date.parse(session.last_seen),
    });
  });
  sessions.forEach((session) => {
    const group = session.parent ? groups.get(session.parent) : undefined;
    if (!group) return;
    group.subagents.push(session);
    group.lastSeen = Math.max(group.lastSeen, Date.parse(session.last_seen));
  });
  groups.forEach((group) =>
    group.subagents.sort((a, b) => Date.parse(b.last_seen) - Date.parse(a.last_seen))
  );
  return [...groups.values()].sort((a, b) => b.lastSeen - a.lastSeen);
}

export const shortSessionId = (id: string) => id.replace(/^[a-z-]+:/i, '').slice(0, 8);

export const sessionLabel = (session: RoutingSession | undefined, id: string) =>
  session?.title || `Session ${shortSessionId(id)}`;

export const formatAgo = (ms: number) => {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m ago`;
  return `${Math.floor(hours / 24)}d ago`;
};

export const formatClock = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

/** Fields that best say what a tool call does, in order of preference. */
const TOOL_SUMMARY_KEYS = [
  'description',
  'command',
  'cmd',
  'file_path',
  'path',
  'pattern',
  'query',
  'url',
  'prompt',
  'skill',
  'subject',
];

/**
 * One line for a tool call: its most telling argument, or the start of its raw input.
 * Input can be cut off (streaming or truncation), so it may not parse.
 */
export function toolSummary(block: ChatBlock): string {
  const raw = (block.text ?? '').trim();
  if (!raw) return '';
  try {
    const input: unknown = JSON.parse(raw);
    if (input && typeof input === 'object' && !Array.isArray(input)) {
      const record = input as Record<string, unknown>;
      for (const key of TOOL_SUMMARY_KEYS) {
        const value = record[key];
        if (typeof value === 'string' && value.trim()) return oneLine(value);
        if (Array.isArray(value) && value.every((v) => typeof v === 'string'))
          return oneLine(value.join(' '));
      }
    }
  } catch {
    // fall through to the raw text
  }
  return oneLine(raw);
}

export const oneLine = (text: string, max = 160) => {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

export interface BlockFilter {
  tools: boolean;
  thinking: boolean;
  context: boolean;
}

export function visibleBlocks(blocks: ChatBlock[], filter: BlockFilter): ChatBlock[] {
  return blocks.filter((block) => {
    if (block.kind === 'tool_use' || block.kind === 'tool_result') return filter.tools;
    if (block.kind === 'thinking') return filter.thinking;
    if (block.kind === 'context') return filter.context;
    return true;
  });
}

/** What kind of turn a message is, for its label. */
export function messageKind(message: ChatMessage): 'user' | 'assistant' | 'tool' | 'system' {
  if (message.role === 'system') return 'system';
  if (message.role === 'assistant') return 'assistant';
  const prose = message.blocks.some((b) => b.kind === 'text' || b.kind === 'image');
  if (!prose && message.blocks.some((b) => b.kind === 'tool_result')) return 'tool';
  if (!prose && message.blocks.every((b) => b.kind === 'context')) return 'system';
  return 'user';
}

export interface OriginFilter {
  key: string;
  label: string;
  /** Session origins it shows; empty means all. */
  origins: string[];
}

export const ORIGIN_FILTERS: OriginFilter[] = [
  { key: 'all', label: 'All', origins: [] },
  { key: 'interactive', label: 'Interactive', origins: ['cli', 'ide'] },
  { key: 'print', label: 'claude -p', origins: ['print'] },
  { key: 'apps', label: 'SDK & apps', origins: ['sdk', 'app'] },
  { key: 'other', label: 'Other', origins: ['other'] },
];

export const originFilter = (key: string | null): OriginFilter =>
  ORIGIN_FILTERS.find((f) => f.key === key) ?? ORIGIN_FILTERS[0];

/** Whether a chat (or one of its subagents) was started the way the filter asks. */
export const groupMatchesOrigin = (group: ChatGroup, filter: OriginFilter) =>
  filter.origins.length === 0 ||
  [group.main, ...group.subagents].some((s) => filter.origins.includes(s.origin || 'other'));

/** Short label for how a chat was started. */
export function originLabel(session: RoutingSession | undefined): string {
  switch (session?.origin) {
    case 'cli':
      return session.provider === 'codex' ? 'codex' : 'interactive';
    case 'print':
      return session.provider === 'codex' ? 'codex exec' : 'claude -p';
    case 'sdk':
      return 'SDK';
    case 'app':
      return /t3[- ]code/i.test(session.user_agent ?? '') ? 'T3 Code' : 'app';
    case 'ide':
      return 'IDE';
    default:
      return '';
  }
}

/**
 * Indents JSON without parsing it, so JSON the proxy cut off (or a stream still arriving)
 * formats too. Whitespace outside strings is dropped and rewritten.
 */
export function prettyJson(text: string, indent = '  '): string {
  let out = '';
  let depth = 0;
  let inString = false;
  let escaped = false;
  const newline = () => `\n${indent.repeat(Math.max(0, depth))}`;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    switch (ch) {
      case '"':
        inString = true;
        out += ch;
        break;
      case '{':
      case '[': {
        let j = i + 1;
        while (j < text.length && /\s/.test(text[j])) j++;
        if (text[j] === (ch === '{' ? '}' : ']')) {
          out += ch + text[j];
          i = j;
        } else {
          depth++;
          out += ch + newline();
        }
        break;
      }
      case '}':
      case ']':
        depth--;
        out += newline() + ch;
        break;
      case ',':
        out += ',' + newline();
        break;
      case ':':
        out += ': ';
        break;
      default:
        if (!/\s/.test(ch)) out += ch;
    }
  }
  return out;
}

const JSON_START = /^[[{]\s*(["{[\]}\d-]|true|false|null)/;

/** Whether text is JSON, or the start of JSON that was cut off. */
export function looksLikeJson(text: string, truncated = false): boolean {
  const trimmed = text.trim();
  if (!JSON_START.test(trimmed)) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    // Cut-off JSON can't parse; accept it when it was cut and is long enough to tell.
    return (truncated || !/[}\]]$/.test(trimmed)) && trimmed.length > 40;
  }
}

/**
 * Splits text into prose and a JSON tail, for prompts like "instructions…\n{…}".
 * json is "" when there is none.
 */
export function splitJson(text: string, truncated = false): { prose: string; json: string } {
  if (looksLikeJson(text, truncated)) return { prose: '', json: text.trim() };
  for (const match of text.matchAll(/\n\s*[[{]/g)) {
    const at = (match.index ?? 0) + 1;
    const tail = text.slice(at);
    if (looksLikeJson(tail, truncated))
      return { prose: text.slice(0, at).trimEnd(), json: tail.trim() };
  }
  return { prose: text, json: '' };
}

export type JsonToken = { text: string; kind?: 'key' | 'string' | 'number' | 'literal' };

const JSON_TOKEN =
  /("(?:[^"\\\n]|\\.)*")(\s*:)?|\b(true|false|null)\b|-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g;

/** Splits formatted JSON into pieces for highlighting. */
export function tokenizeJson(text: string): JsonToken[] {
  const tokens: JsonToken[] = [];
  let last = 0;
  for (const m of text.matchAll(JSON_TOKEN)) {
    const at = m.index ?? 0;
    if (at > last) tokens.push({ text: text.slice(last, at) });
    if (m[1] !== undefined) {
      tokens.push({ text: m[1], kind: m[2] ? 'key' : 'string' });
      if (m[2]) tokens.push({ text: m[2] });
    } else {
      tokens.push({ text: m[0], kind: m[3] ? 'literal' : 'number' });
    }
    last = at + m[0].length;
  }
  if (last < text.length) tokens.push({ text: text.slice(last) });
  return tokens;
}

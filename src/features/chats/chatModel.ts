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

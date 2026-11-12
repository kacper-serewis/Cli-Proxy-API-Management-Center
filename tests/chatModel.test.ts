import { describe, expect, test } from 'bun:test';
import type { ChatMessage, RoutingSession } from '../src/services/api';
import {
  groupChats,
  messageKind,
  toolSummary,
  visibleBlocks,
} from '../src/features/chats/chatModel';

const session = (id: string, lastSeen: string, parent?: string): RoutingSession => ({
  id,
  parent,
  provider: 'claude',
  auth: 'claude-a.json',
  model: 'claude-opus-5-5',
  models: {},
  requests: 1,
  first_seen: lastSeen,
  last_seen: lastSeen,
});

describe('chat model', () => {
  test('groups subagents under their chat and sorts by latest activity', () => {
    const groups = groupChats([
      session('a', '2026-11-12T09:00:00Z'),
      session('b', '2026-11-12T09:05:00Z'),
      session('a-sub', '2026-11-12T09:10:00Z', 'a'),
      session('orphan', '2026-11-12T08:00:00Z', 'gone'),
    ]);
    expect(groups.map((g) => g.main.id)).toEqual(['a', 'b', 'orphan']);
    expect(groups[0].subagents.map((s) => s.id)).toEqual(['a-sub']);
  });

  test('summarises a tool call by its most telling argument', () => {
    expect(
      toolSummary({
        kind: 'tool_use',
        name: 'Bash',
        text: '{"command":"ls -la","description":"List files"}',
      })
    ).toBe('List files');
    expect(toolSummary({ kind: 'tool_use', name: 'Read', text: '{"file_path":"/a/b.go"}' })).toBe(
      '/a/b.go'
    );
    expect(toolSummary({ kind: 'tool_use', name: 'shell', text: '{"cmd":["git","status"]}' })).toBe(
      'git status'
    );
    expect(toolSummary({ kind: 'tool_use', name: 'Edit', text: '{"file_pa' })).toBe('{"file_pa');
  });

  test('filters blocks and labels turns', () => {
    const toolOutput: ChatMessage = {
      seq: 1,
      role: 'user',
      at: '2026-11-12T09:00:00Z',
      blocks: [{ kind: 'tool_result', text: 'ok' }],
    };
    expect(messageKind(toolOutput)).toBe('tool');
    expect(messageKind({ ...toolOutput, blocks: [{ kind: 'context', text: '<x>' }] })).toBe(
      'system'
    );
    expect(messageKind({ ...toolOutput, blocks: [{ kind: 'text', text: 'hi' }] })).toBe('user');
    const blocks = [
      { kind: 'text' as const, text: 'a' },
      { kind: 'thinking' as const, text: 'b' },
      { kind: 'tool_use' as const, text: '{}' },
      { kind: 'context' as const, text: 'c' },
    ];
    expect(
      visibleBlocks(blocks, { tools: false, thinking: false, context: false }).map((b) => b.kind)
    ).toEqual(['text']);
    expect(visibleBlocks(blocks, { tools: true, thinking: true, context: false })).toHaveLength(3);
  });
});

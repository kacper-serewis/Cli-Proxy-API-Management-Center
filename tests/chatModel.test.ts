import { describe, expect, test } from 'bun:test';
import type { ChatMessage, RoutingSession } from '../src/services/api';
import {
  groupChats,
  groupMatchesOrigin,
  looksLikeJson,
  prettyJson,
  splitJson,
  tokenizeJson,
  messageKind,
  originFilter,
  originLabel,
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

  test('filters chats by how they were started', () => {
    const run = { ...session('p', '2026-11-12T09:00:00Z'), origin: 'print' };
    const [group] = groupChats([run]);
    expect(groupMatchesOrigin(group, originFilter('print'))).toBe(true);
    expect(groupMatchesOrigin(group, originFilter('interactive'))).toBe(false);
    expect(groupMatchesOrigin(group, originFilter(null))).toBe(true);
    expect(originLabel(run)).toBe('claude -p');
    expect(originLabel({ ...run, provider: 'codex' })).toBe('codex exec');
    expect(
      originLabel({
        ...run,
        origin: 'app',
        user_agent: 'claude-cli/2.1.322 (external, t3-code, agent-sdk/0.3.321)',
      })
    ).toBe('T3 Code');
    const [unknown] = groupChats([session('u', '2026-11-12T09:00:00Z')]);
    expect(groupMatchesOrigin(unknown, originFilter('other'))).toBe(true);
  });
});

describe('json in chats', () => {
  test('formats complete and cut-off JSON', () => {
    expect(prettyJson('{"a":1,"b":[],"c":{"d":"x, y: {z}"}}')).toBe(
      '{\n  "a": 1,\n  "b": [],\n  "c": {\n    "d": "x, y: {z}"\n  }\n}'
    );
    expect(prettyJson('{"a":[1,2],"b":"cut')).toBe('{\n  "a": [\n    1,\n    2\n  ],\n  "b": "cut');
  });

  test('recognises JSON only when it is JSON', () => {
    expect(looksLikeJson('{"eigenaar":"2","berichten":[{"id":"1"}]}')).toBe(true);
    expect(
      looksLikeJson('{"eigenaar":"2","berichten":[{"id":"1","tekst":"long enough to tell', true)
    ).toBe(true);
    expect(looksLikeJson('{name} is a placeholder')).toBe(false);
    expect(looksLikeJson('[image]')).toBe(false);
    expect(looksLikeJson('plain text')).toBe(false);
  });

  test('splits a prompt into prose and its JSON tail', () => {
    expect(splitJson('Sort these mails:\n\n{"mails":[{"from":"a"}]}')).toEqual({
      prose: 'Sort these mails:',
      json: '{"mails":[{"from":"a"}]}',
    });
    expect(splitJson('no json here').json).toBe('');
  });

  test('tokenizes keys, strings, numbers and literals', () => {
    const kinds = tokenizeJson('{\n  "a": "b",\n  "n": -1.5,\n  "t": true\n}')
      .filter((t) => t.kind)
      .map((t) => `${t.kind}:${t.text}`);
    expect(kinds).toEqual([
      'key:"a"',
      'string:"b"',
      'key:"n"',
      'number:-1.5',
      'key:"t"',
      'literal:true',
    ]);
  });
});

import { describe, expect, it } from 'bun:test';
import { accountProvider, shortAccountName } from '../src/features/quota/accountNames';

describe('shortAccountName', () => {
  it('keeps the mailbox of provider-hash-email credential files', () => {
    expect(shortAccountName('claude-e36c4ea2-team@stofloos.nl.json')).toBe('team');
    expect(shortAccountName('codex-07a82941-developers@stofloos.nl-prolite.json')).toBe('developers');
  });

  it('leaves other names readable', () => {
    expect(shortAccountName('my-key.json')).toBe('my-key');
    expect(shortAccountName('vertex')).toBe('vertex');
  });
});

describe('accountProvider', () => {
  it('reads the provider prefix', () => {
    expect(accountProvider('claude-e36c4ea2-team@stofloos.nl.json')).toBe('claude');
    expect(accountProvider('codex-07a82941-developers@stofloos.nl-prolite.json')).toBe('codex');
  });
});

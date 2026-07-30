import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { extractMessages, makeBatches } from '../../skills/ruminate/scripts/extract-conversations';

const SCRIPT = join(import.meta.dir, '../../skills/ruminate/scripts/extract-conversations.ts');

const line = (obj: unknown) => JSON.stringify(obj);

describe('extractMessages', () => {
  test('extracts user and assistant text, tagging each side', () => {
    const jsonl = [
      line({ type: 'user', message: { content: 'please fix the login redirect bug' } }),
      line({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'the redirect drops the query string' }] },
      }),
    ].join('\n');
    const out = extractMessages(jsonl);
    expect(out).toEqual([
      '[USER]: please fix the login redirect bug',
      '[ASSISTANT]: the redirect drops the query string',
    ]);
  });

  test('skips meta user messages, short strings, and system-reminder-only blocks', () => {
    const jsonl = [
      line({ type: 'user', isMeta: true, message: { content: 'meta message that is long enough' } }),
      line({ type: 'user', message: { content: 'short' } }),
      line({
        type: 'user',
        message: { content: '<system-reminder>reminder body text here</system-reminder>' },
      }),
      line({ type: 'user', message: { content: 'a real user correction worth keeping' } }),
    ].join('\n');
    expect(extractMessages(jsonl)).toEqual(['[USER]: a real user correction worth keeping']);
  });

  test('tolerates invalid JSON lines and non-object messages', () => {
    const jsonl = [
      'not json at all {{{',
      line({ type: 'user', message: 'just-a-string' }),
      line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash' }] } }),
      line({ type: 'user', message: { content: 'survives the garbage around it fine' } }),
    ].join('\n');
    expect(extractMessages(jsonl)).toEqual(['[USER]: survives the garbage around it fine']);
  });

  test('truncates user text at 3000 chars and assistant text at 800', () => {
    const jsonl = [
      line({ type: 'user', message: { content: 'u'.repeat(5000) } }),
      line({ type: 'assistant', message: { content: [{ type: 'text', text: 'a'.repeat(2000) }] } }),
    ].join('\n');
    const [user, assistant] = extractMessages(jsonl);
    expect(user.length).toBe('[USER]: '.length + 3000);
    expect(assistant.length).toBe('[ASSISTANT]: '.length + 800);
  });
});

describe('makeBatches', () => {
  test('splits files across the requested number of batches', () => {
    const files = ['a', 'b', 'c', 'd', 'e'];
    const batches = makeBatches(files, 2);
    expect(batches.length).toBe(2);
    expect(batches.flat()).toEqual(files);
  });

  test('drops empty trailing batches instead of emitting them', () => {
    expect(makeBatches(['a', 'b'], 5).length).toBe(2);
  });
});

describe('CLI end-to-end', () => {
  test('extracts conversations and writes batch manifests', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ruminate-'));
    try {
      const conv = join(dir, 'conversations');
      const out = join(dir, 'out');
      mkdirSync(conv);
      const body = [
        line({ type: 'user', message: { content: 'remember: deploys go through the gitops repo' } }),
        line({
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'noted — the app repo never deploys directly' }] },
        }),
      ].join('\n');
      writeFileSync(join(conv, 'aaaa.jsonl'), `${body}\n`.repeat(20));
      writeFileSync(join(conv, 'bbbb.jsonl'), `${body}\n`.repeat(20));
      writeFileSync(join(conv, 'tiny.jsonl'), line({ type: 'user', message: { content: 'x' } }));

      const run = spawnSync('bun', [SCRIPT, conv, out, '--batches', '2'], { encoding: 'utf8' });
      expect(run.status).toBe(0);
      expect(run.stdout.trim()).toBe(out);

      const extracted = readdirSync(out).filter((f) => f.endsWith('.txt'));
      expect(extracted.length).toBe(2);
      const sample = readFileSync(join(out, extracted[0]), 'utf8');
      expect(sample).toContain('[USER]: remember: deploys go through the gitops repo');

      const manifests = readdirSync(join(out, 'batches'));
      expect(manifests.length).toBe(2);
      for (const m of manifests) {
        const listed = readFileSync(join(out, 'batches', m), 'utf8').trim().split('\n');
        for (const p of listed) expect(p.startsWith(out)).toBe(true);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

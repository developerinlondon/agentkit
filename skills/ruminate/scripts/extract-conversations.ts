#!/usr/bin/env bun
// Extract user/assistant text from Claude Code conversation JSONL files into
// per-conversation .txt files plus batch manifests for parallel analysis.
// Usage: extract-conversations.ts <project-dir> <output-dir>
//        [--batches N] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--min-size BYTES]

import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const USER_LIMIT = 3000;
const ASSISTANT_LIMIT = 800;

export function extractMessages(jsonl: string): string[] {
  const messages: string[] = [];
  for (const line of jsonl.split('\n')) {
    let record: any;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof record !== 'object' || record === null) continue;
    const message = record.message;
    if (typeof message !== 'object' || message === null) continue;

    const content = message.content;
    const texts: string[] = [];
    if (typeof content === 'string') {
      texts.push(content);
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (part && typeof part === 'object' && part.type === 'text') texts.push(part.text);
      }
    }

    for (const text of texts) {
      const clean = text.trim();
      if (clean.length <= 10) continue;
      if (clean.startsWith('<system-reminder>') && clean.endsWith('</system-reminder>')) continue;
      if (record.type === 'user' && !record.isMeta) {
        messages.push(`[USER]: ${text.slice(0, USER_LIMIT)}`);
      } else if (record.type === 'assistant') {
        messages.push(`[ASSISTANT]: ${text.slice(0, ASSISTANT_LIMIT)}`);
      }
    }
  }
  return messages;
}

export function makeBatches(files: string[], batches: number): string[][] {
  const size = Math.max(1, Math.ceil(files.length / Math.max(1, batches)));
  const out: string[][] = [];
  for (let i = 0; i < files.length; i += size) out.push(files.slice(i, i + size));
  return out;
}

interface Options {
  projectDir: string;
  outputDir: string;
  batches: number;
  from?: Date;
  to?: Date;
  minSize: number;
}

function parseArgs(argv: string[]): Options {
  const positional: string[] = [];
  const opts: Options = { projectDir: '', outputDir: '', batches: 5, minSize: 500 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--batches':
        opts.batches = Number(argv[++i]);
        break;
      case '--from':
        opts.from = new Date(`${argv[++i]}T00:00:00`);
        break;
      case '--to':
        opts.to = new Date(`${argv[++i]}T23:59:59.999`);
        break;
      case '--min-size':
        opts.minSize = Number(argv[++i]);
        break;
      default:
        positional.push(arg);
    }
  }
  if (positional.length !== 2 || !Number.isFinite(opts.batches) || opts.batches < 1) {
    console.error(
      'usage: extract-conversations.ts <project-dir> <output-dir> [--batches N] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--min-size BYTES]',
    );
    process.exit(2);
  }
  [opts.projectDir, opts.outputDir] = positional;
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  mkdirSync(opts.outputDir, { recursive: true });

  const candidates = readdirSync(opts.projectDir)
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => join(opts.projectDir, name))
    .filter((path) => {
      const stat = statSync(path);
      if (stat.size < opts.minSize) return false;
      if (opts.from && stat.mtime < opts.from) return false;
      if (opts.to && stat.mtime > opts.to) return false;
      return true;
    })
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  console.error(`Found ${candidates.length} conversations passing filters`);

  const extracted: string[] = [];
  candidates.forEach((path, idx) => {
    const messages = extractMessages(readFileSync(path, 'utf8'));
    if (messages.length === 0) return;
    const name = basename(path).replace(/\.jsonl$/, '');
    const outPath = join(opts.outputDir, `${String(idx).padStart(3, '0')}_${name}.txt`);
    writeFileSync(outPath, messages.join('\n\n'));
    extracted.push(outPath);
  });
  console.error(`Extracted ${extracted.length} conversations with content`);

  const batchDir = join(opts.outputDir, 'batches');
  mkdirSync(batchDir, { recursive: true });
  makeBatches(extracted, opts.batches).forEach((batch, i) => {
    writeFileSync(join(batchDir, `batch_${i}.txt`), `${batch.join('\n')}\n`);
    console.error(`Batch ${i}: ${batch.length} conversations`);
  });

  console.log(opts.outputDir);
}

if (import.meta.main) main();

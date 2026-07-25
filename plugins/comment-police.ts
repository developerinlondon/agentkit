import type { PluginInput } from '@opencode-ai/plugin';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import path from 'node:path';

interface CommentPoliceConfig {
  maxBlockLines: number;
  maxHeaderLines: number;
  maxCommentRatio: number;
  forbiddenPatterns: string[];
  excludePatterns: string[];
}

const DEFAULTS: CommentPoliceConfig = {
  maxBlockLines: 6,
  maxHeaderLines: 10,
  maxCommentRatio: 0.3,
  forbiddenPatterns: [
    'Plan-?\\d+',
    'plan \\d',
    'PR\\s*#?\\d+',
    'closes\\s*#\\d+',
    'fixes\\s*#\\d+',
    'TODO[: ]+(for|after|once)\\b',
    'for the v\\d',
    'added (when|for) (we|the)',
    'as part of (this|the) (PR|MR|fix)',
    'see (issue|ticket|PR|MR)',
    // Bare refs rot the same way spelled-out ones do, and are what agents
    // reach for: a hash or bang glued to a number, often after a repo slug.
    '[#!]\\d{1,6}(\\D|$)',
    '(gitlab|github)\\.com/\\S*/(issues|merge_requests|pull)/',
    '(commit|sha)\\s+[0-9a-f]{7,40}',
  ],
  excludePatterns: [],
};

const TARGET_FILE =
  /\.(ts|tsx|js|jsx|py|rb|go|rs|java|kt|cs|cpp|c|h|hpp|swift|scala|vue|svelte|sh|bash|yaml|yml|toml)$|Dockerfile(\..+)?$/;

const SKIP_FILES =
  /\.(lock|min\.\w+|generated\.\w+|snap|d\.ts)$|package-lock\.json|yarn\.lock|pnpm-lock\.yaml/;

function configPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(xdg, 'agentkit', 'config.yaml');
}

export function loadConfig(): CommentPoliceConfig {
  try {
    const content = readFileSync(configPath(), 'utf-8');
    const lines = content.split('\n');
    let inSection = false;
    const sectionLines: string[] = [];
    for (const line of lines) {
      if (/^comment-police:/.test(line)) {
        inSection = true;
        continue;
      }
      if (inSection) {
        if (/^\S/.test(line)) break;
        sectionLines.push(line);
      }
    }
    if (sectionLines.length === 0) return { ...DEFAULTS };
    const section = sectionLines.join('\n');

    const block = section.match(/max-block-lines:\s*(\d+)/);
    const header = section.match(/max-header-lines:\s*(\d+)/);
    const ratio = section.match(/max-comment-ratio:\s*([0-9.]+)/);
    const forbiddenMatch = section.match(
      /forbidden-patterns:\s*\n((?:\s*-\s*.+\n?)*)/,
    );
    const forbidden = forbiddenMatch
      ? [...forbiddenMatch[1].matchAll(/^\s*-\s+(.+)$/gm)].map((m) =>
          m[1].trim().replace(/^["']|["']$/g, ''),
        )
      : DEFAULTS.forbiddenPatterns;
    const excludeMatch = section.match(
      /exclude-patterns:\s*\n((?:\s*-\s*.+\n?)*)/,
    );
    const excludes = excludeMatch
      ? [...excludeMatch[1].matchAll(/^\s*-\s+(.+)$/gm)].map((m) =>
          m[1].trim(),
        )
      : DEFAULTS.excludePatterns;

    return {
      maxBlockLines: block ? parseInt(block[1], 10) : DEFAULTS.maxBlockLines,
      maxHeaderLines: header
        ? parseInt(header[1], 10)
        : DEFAULTS.maxHeaderLines,
      maxCommentRatio: ratio
        ? parseFloat(ratio[1])
        : DEFAULTS.maxCommentRatio,
      forbiddenPatterns: forbidden,
      excludePatterns: excludes,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

// Map a file extension to the line-comment marker(s) it uses. Block-comment
// detection (`/* */`, `=begin/=end`) is handled separately below.
function lineCommentMarkers(filename: string): RegExp {
  if (/\.(py|rb|sh|bash|yaml|yml|toml)$|Dockerfile/.test(filename)) {
    return /^\s*#(?!!)/;
  }
  if (/\.(ts|tsx|js|jsx|go|rs|java|kt|cs|cpp|c|h|hpp|swift|scala)$/.test(filename)) {
    return /^\s*\/\//;
  }
  if (/\.(vue|svelte)$/.test(filename)) {
    // HTML-style comments inside templates; line `//` inside scripts.
    return /^\s*(\/\/|<!--)/;
  }
  return /^\s*(\/\/|#)/;
}

interface CommentBlock {
  startLine: number; // 1-indexed
  lines: string[];
}

export function findCommentBlocks(
  source: string[],
  marker: RegExp,
): CommentBlock[] {
  const blocks: CommentBlock[] = [];
  let current: CommentBlock | null = null;
  for (let i = 0; i < source.length; i++) {
    if (marker.test(source[i])) {
      if (!current) current = { startLine: i + 1, lines: [] };
      current.lines.push(source[i]);
    } else if (current) {
      blocks.push(current);
      current = null;
    }
  }
  if (current) blocks.push(current);
  return blocks;
}

export function commentLineCount(source: string[], marker: RegExp): number {
  return source.filter((l) => marker.test(l)).length;
}

export function codeLineCount(source: string[], marker: RegExp): number {
  return source.filter((l) => l.trim() !== '' && !marker.test(l)).length;
}

export function checkBlocks(
  blocks: CommentBlock[],
  maxBlockLines: number,
  maxHeaderLines: number,
  forbidden: RegExp[],
): string[] {
  const warnings: string[] = [];
  for (const b of blocks) {
    const isHeader = b.startLine <= 3;
    const limit = isHeader ? maxHeaderLines : maxBlockLines;
    if (b.lines.length > limit) {
      warnings.push(
        `${isHeader ? 'tutorial-style file header' : 'long comment block'} at line ${b.startLine}: ${b.lines.length} lines (limit: ${limit})`,
      );
    }
    const text = b.lines.join('\n');
    for (const pat of forbidden) {
      const m = text.match(pat);
      if (m) {
        warnings.push(
          `comment block at line ${b.startLine} contains a rotting reference: \`${m[0]}\` — move it to the PR description / commit message`,
        );
        break;
      }
    }
  }
  return warnings;
}

export function checkRatio(
  source: string[],
  marker: RegExp,
  maxRatio: number,
): string | null {
  const code = codeLineCount(source, marker);
  const comments = commentLineCount(source, marker);
  if (code === 0) return null;
  const ratio = comments / (code + comments);
  if (ratio > maxRatio) {
    return `comment-to-code ratio ${(ratio * 100).toFixed(0)}% exceeds ${(maxRatio * 100).toFixed(0)}% (${comments} comment lines vs ${code} code lines)`;
  }
  return null;
}

export const CommentPolice = {
  name: 'comment-police',
  hooks: ({ ctx }: PluginInput) => {
    return {
      'tool.execute.after': async (
        input: { tool: string },
        output: { title?: string; output?: string },
      ) => {
        if (!['edit', 'write'].includes(input.tool)) return;
        const rel = output.title;
        if (!rel) return;
        if (!TARGET_FILE.test(rel)) return;
        if (SKIP_FILES.test(rel)) return;

        const config = loadConfig();
        if (config.excludePatterns.some((p) => rel.includes(p))) return;

        const abs = path.isAbsolute(rel)
          ? rel
          : path.resolve(ctx.worktree, rel);
        let content: string;
        try {
          content = readFileSync(abs, 'utf-8');
        } catch {
          return;
        }
        const lines = content.split('\n');
        const marker = lineCommentMarkers(rel);
        const blocks = findCommentBlocks(lines, marker);
        const forbidden = config.forbiddenPatterns.map(
          (p) => new RegExp(p, 'i'),
        );

        const warnings: string[] = [];
        warnings.push(
          ...checkBlocks(
            blocks,
            config.maxBlockLines,
            config.maxHeaderLines,
            forbidden,
          ),
        );
        const ratioWarning = checkRatio(
          lines,
          marker,
          config.maxCommentRatio,
        );
        if (ratioWarning) warnings.push(ratioWarning);

        if (warnings.length === 0) return;

        output.output =
          (output.output ?? '') +
          `\n\nCOMMENT DISCIPLINE (comment-police)\n` +
          `${'='.repeat(50)}\n` +
          warnings.map((w, i) => `${i + 1}. ${w}`).join('\n\n') +
          `\n\n` +
          `Default to no comments. Add only when WHY is non-obvious and removing the comment would confuse a future reader without conversation context. PR description / commit message is the durable home for "why this change was made". See agentkit rules/comment-discipline.md.`;
      },
    };
  },
};

export default CommentPolice;

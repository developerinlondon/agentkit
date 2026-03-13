import type { PluginInput } from '@opencode-ai/plugin';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

interface CodingPoliceConfig {
  maxFileLines: number;
  maxFunctionLines: number;
  minDuplicateLines: number;
  maxExportsPerFile: number;
  excludePatterns: string[];
}

const DEFAULTS: CodingPoliceConfig = {
  maxFileLines: 1000,
  maxFunctionLines: 100,
  minDuplicateLines: 6,
  maxExportsPerFile: 15,
  excludePatterns: [],
};

const CODE_FILE =
  /\.(ts|tsx|js|jsx|py|rb|go|rs|java|kt|cs|cpp|c|h|hpp|swift|scala|vue|svelte)$/;

// Files that are legitimately long (auto-generated, lockfiles, etc.)
const SKIP_FILES =
  /\.(lock|min\.\w+|generated\.\w+|snap|d\.ts)$|package-lock\.json|yarn\.lock|pnpm-lock\.yaml/;

function getAgentkitConfigPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(xdg, 'agentkit', 'config.yaml');
}

/**
 * Lightweight YAML parser for the coding-police section.
 * Follows the same hand-rolled approach as git-police to avoid deps.
 */
export function loadConfig(): CodingPoliceConfig {
  try {
    const content = readFileSync(getAgentkitConfigPath(), 'utf-8');
    const lines = content.split('\n');
    let inSection = false;
    const sectionLines: string[] = [];

    for (const line of lines) {
      if (/^coding-police:/.test(line)) {
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

    const maxFile = section.match(/max-file-lines:\s*(\d+)/);
    const maxFunc = section.match(/max-function-lines:\s*(\d+)/);
    const minDup = section.match(/min-duplicate-lines:\s*(\d+)/);
    const maxExp = section.match(/max-exports-per-file:\s*(\d+)/);

    const excludeMatch = section.match(
      /exclude-patterns:\s*\n((?:\s*-\s*.+\n?)*)/,
    );
    const excludes = excludeMatch
      ? [...excludeMatch[1].matchAll(/^\s*-\s+(.+)$/gm)].map((m) =>
          m[1].trim(),
        )
      : [];

    return {
      maxFileLines: maxFile ? parseInt(maxFile[1], 10) : DEFAULTS.maxFileLines,
      maxFunctionLines: maxFunc
        ? parseInt(maxFunc[1], 10)
        : DEFAULTS.maxFunctionLines,
      minDuplicateLines: minDup
        ? parseInt(minDup[1], 10)
        : DEFAULTS.minDuplicateLines,
      maxExportsPerFile: maxExp
        ? parseInt(maxExp[1], 10)
        : DEFAULTS.maxExportsPerFile,
      excludePatterns: excludes.length > 0 ? excludes : DEFAULTS.excludePatterns,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

/**
 * Check 1: File length — files over the threshold must be split.
 */
export function checkFileLength(
  lines: string[],
  maxLines: number,
): string | null {
  if (lines.length <= maxLines) return null;

  const excess = lines.length - maxLines;
  return (
    `FILE TOO LONG: ${lines.length} lines (limit: ${maxLines}, over by ${excess}).\n` +
    `  Split this file into smaller modules grouped by functionality.\n` +
    `  Identify logical boundaries (types, helpers, handlers, constants) and extract them.`
  );
}

/**
 * Check 2: Function/method length — long functions violate modularity.
 *
 * Detects functions in: TypeScript/JavaScript, Python, Go, Rust, Java/Kotlin/C#.
 * Returns warnings for every function exceeding the threshold.
 */
export function checkFunctionLengths(
  lines: string[],
  maxLines: number,
): string[] {
  const warnings: string[] = [];

  // Pattern: opening of a function (not perfect, but good enough for LLM guidance)
  const funcStartPatterns = [
    // TS/JS: function name(, async function, arrow assigned, method
    /^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)/,
    /^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\(/,
    /^\s*(?:public|private|protected|static|async|\s)*(\w+)\s*\([^)]*\)\s*(?::\s*\S+)?\s*\{/,
    // Python: def name(
    /^\s*(?:async\s+)?def\s+(\w+)\s*\(/,
    // Go: func name(  or func (receiver) name(
    /^\s*func\s+(?:\([^)]*\)\s+)?(\w+)\s*\(/,
    // Rust: fn name(
    /^\s*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/,
  ];

  let currentFunc: { name: string; startLine: number } | null = null;
  let braceDepth = 0;
  let indentBaseline = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Try to match a function start
    if (!currentFunc) {
      for (const pattern of funcStartPatterns) {
        const match = line.match(pattern);
        if (match) {
          currentFunc = { name: match[1], startLine: i + 1 };
          braceDepth = 0;
          indentBaseline = line.search(/\S/);
          break;
        }
      }
    }

    if (currentFunc) {
      // Track brace depth for brace-based languages
      for (const ch of line) {
        if (ch === '{') braceDepth++;
        if (ch === '}') braceDepth--;
      }

      // Function ends when brace depth returns to 0, or when we hit a
      // dedented non-blank line (Python-style)
      const isEnd =
        (braceDepth <= 0 && i > currentFunc.startLine - 1 && line.includes('}')) ||
        (indentBaseline >= 0 &&
          i > currentFunc.startLine &&
          line.trim() !== '' &&
          !line.match(/^\s*#/) &&
          line.search(/\S/) <= indentBaseline &&
          !line.match(/^\s*[})\]]/));

      if (isEnd || i === lines.length - 1) {
        const length = i - currentFunc.startLine + 2;
        if (length > maxLines) {
          warnings.push(
            `LONG FUNCTION: \`${currentFunc.name}\` is ${length} lines (limit: ${maxLines}, starts at line ${currentFunc.startLine}).` +
              ` Break it into smaller helper functions.`,
          );
        }
        currentFunc = null;
        braceDepth = 0;
      }
    }
  }

  return warnings;
}

/**
 * Check 3: Duplicate code blocks — finds repeated sequences of non-trivial lines.
 *
 * Normalises whitespace and skips blank/comment lines before comparison.
 * Returns warnings when identical blocks of `minLines` or more are found.
 */
export function checkDuplicateBlocks(
  lines: string[],
  minLines: number,
): string[] {
  const warnings: string[] = [];

  // Normalise: trim, skip blank lines, single-line comments, import/require
  const normalised: { text: string; originalLine: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (
      trimmed === '' ||
      trimmed.startsWith('//') ||
      trimmed.startsWith('#') ||
      trimmed.startsWith('*') ||
      trimmed.startsWith('/*') ||
      trimmed.startsWith('*/') ||
      /^(import|from|require|use |using )/.test(trimmed) ||
      /^[{}()\[\];,]$/.test(trimmed)
    ) {
      continue;
    }
    normalised.push({ text: trimmed, originalLine: i + 1 });
  }

  // Sliding window: hash blocks of `minLines` normalised lines
  const seen = new Map<string, number>(); // hash -> first occurrence original line
  const reported = new Set<string>();

  for (let i = 0; i <= normalised.length - minLines; i++) {
    const block = normalised
      .slice(i, i + minLines)
      .map((l) => l.text)
      .join('\n');

    if (seen.has(block)) {
      const firstLine = seen.get(block)!;
      const dupeLine = normalised[i].originalLine;
      const key = `${firstLine}:${dupeLine}`;

      if (!reported.has(key)) {
        reported.add(key);
        warnings.push(
          `DUPLICATE CODE: ${minLines}+ line block duplicated at lines ${firstLine} and ${dupeLine}.` +
            ` Extract into a shared function to keep code DRY.`,
        );
      }
    } else {
      seen.set(block, normalised[i].originalLine);
    }
  }

  return warnings;
}

/**
 * Check 4: Export count — too many exports means the file has too many responsibilities.
 */
export function checkExportCount(
  lines: string[],
  maxExports: number,
): string | null {
  let count = 0;
  for (const line of lines) {
    if (/^\s*export\s+(default\s+)?(?:function|class|const|let|var|type|interface|enum|async)/.test(line)) {
      count++;
    }
  }

  if (count > maxExports) {
    return (
      `TOO MANY EXPORTS: ${count} exports in this file (limit: ${maxExports}).\n` +
      `  This suggests the file has multiple responsibilities.\n` +
      `  Group related exports into separate modules (e.g., types.ts, helpers.ts, constants.ts).`
    );
  }

  return null;
}

// ---------------------------------------------------------------------------
// Plugin entry point
// ---------------------------------------------------------------------------

export default async function codingPolice(ctx: PluginInput) {
  const config = loadConfig();

  return {
    'tool.execute.after': async (
      input: { tool: string; sessionID: string; callID: string },
      output: { title: string; output: string; metadata: unknown },
    ) => {
      const toolName = input.tool?.toLowerCase();
      if (toolName !== 'edit' && toolName !== 'write') return;

      const relativePath = output.title;
      if (!relativePath) return;

      // Only check code files
      if (!CODE_FILE.test(relativePath)) return;
      // Skip generated/lock files
      if (SKIP_FILES.test(relativePath)) return;
      // Check exclusion patterns from config
      if (
        config.excludePatterns.some((pattern) => relativePath.includes(pattern))
      ) {
        return;
      }

      const absPath = path.isAbsolute(relativePath)
        ? relativePath
        : path.resolve(ctx.worktree, relativePath);

      let content: string;
      try {
        content = readFileSync(absPath, 'utf-8');
      } catch {
        return;
      }

      const lines = content.split('\n');
      const violations: string[] = [];

      // Check 1: File length
      const lengthWarning = checkFileLength(lines, config.maxFileLines);
      if (lengthWarning) violations.push(lengthWarning);

      // Check 2: Function lengths
      const funcWarnings = checkFunctionLengths(lines, config.maxFunctionLines);
      violations.push(...funcWarnings);

      // Check 3: Duplicate code blocks
      const dupeWarnings = checkDuplicateBlocks(lines, config.minDuplicateLines);
      violations.push(...dupeWarnings);

      // Check 4: Export count (TS/JS only)
      if (/\.(ts|tsx|js|jsx)$/.test(relativePath)) {
        const exportWarning = checkExportCount(lines, config.maxExportsPerFile);
        if (exportWarning) violations.push(exportWarning);
      }

      if (violations.length === 0) return;

      output.output +=
        `\n\n` +
        `CODING STANDARDS VIOLATION (coding-police)\n` +
        `${'='.repeat(50)}\n` +
        violations.map((v, i) => `${i + 1}. ${v}`).join('\n\n') +
        `\n\n` +
        `REQUIRED ACTIONS:\n` +
        `- Keep code DRY: extract duplicated logic into shared functions.\n` +
        `- Keep files modular: split files exceeding ${config.maxFileLines} lines by functionality.\n` +
        `- Keep functions focused: break functions over ${config.maxFunctionLines} lines into composable helpers.\n` +
        `- Apply Single Responsibility: each file should have one clear purpose.\n` +
        `\n` +
        `Fix these violations before proceeding.`;
    },
  };
}

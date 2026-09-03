import { describe, expect, test } from 'bun:test';
import type { PluginInput } from '@opencode-ai/plugin';
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, join, relative } from 'node:path';
import {
  kitHasSkills,
  pluginIdFor,
  readSkillKits,
  skillsInKit,
} from '../scripts/skill-kits';

// Recursive: some skills carry a references/ subdirectory, and a nested file
// that drifts is exactly as misleading as a top-level one. Walking git-tracked
// files rather than the filesystem means a gitignored build artifact (e.g.
// skills/diagram/renderer/bundle.js, which SKILL.md tells the author to build
// locally) cannot break parity by existing on one side and not the other.
const filesUnder = (dir: string): string[] => {
  if (!existsSync(dir)) return [];
  const out = execFileSync('git', ['ls-files', '--', dir], { cwd: repoRoot, encoding: 'utf-8' });
  return out.split('\n').filter(Boolean).map((f) => relative(dir, join(repoRoot, f))).sort();
};

// The comprehensive "agentkit" Claude Code plugin bundles, in one install:
//   - the enforcement police hooks (wired via hooks/hooks.json),
//   - the agentkit skills, and
//   - both MCP toolchains (assay + a copy of the infra-tools server).
// These tests pin that wiring so a regression (a missing/renamed script, a
// dropped MCP server, a hook that lost its executable bit) fails loudly instead
// of shipping a plugin that half-installs.

const repoRoot = join(import.meta.dir, '..');
const pluginDir = join(repoRoot, 'plugins-cc', 'agentkit');
const reviewPluginDir = join(repoRoot, 'plugins-cc', 'agentkit-adversarial-review');
const memoryPluginDir = join(repoRoot, 'plugins-cc', 'agentkit-brain');
const openCodePluginDir = join(repoRoot, 'plugins');

type PluginServer = (input: PluginInput) => Promise<unknown>;

function openCodeServers(plugin: Record<string, unknown>, id: string): PluginServer[] {
  const entry = plugin.default;
  if (
    entry !== null
    && typeof entry === 'object'
    && ('id' in entry || 'server' in entry || 'tui' in entry)
  ) {
    const module = entry as Record<string, unknown>;
    expect(module.id).toBe(id);
    expect(typeof module.server).toBe('function');
    if (typeof module.server !== 'function') throw new TypeError('Plugin server is not a function');
    return [module.server as PluginServer];
  }

  const seen = new Set<unknown>();
  return Object.values(plugin).flatMap((value) => {
    if (seen.has(value)) return [];
    seen.add(value);
    const server = typeof value === 'function'
      ? value
      : value !== null && typeof value === 'object' && 'server' in value
      && typeof value.server === 'function'
      ? value.server
      : undefined;
    if (!server) throw new TypeError('Plugin export is not a function');
    return [server as PluginServer];
  });
}

describe('OpenCode policy plugin modules', () => {
  for (const file of readdirSync(openCodePluginDir).filter((name) => name.endsWith('.ts')).sort()) {
    test(`${file} loads exactly one active hook object`, async () => {
      const plugin = await import(join(openCodePluginDir, file)) as Record<string, unknown>;
      const input = { directory: repoRoot, worktree: repoRoot } as PluginInput;
      const hooks = await Promise.all(
        openCodeServers(plugin, file.replace(/\.ts$/, '')).map((server) => server(input)),
      );

      expect(hooks).toHaveLength(1);
      expect(hooks[0]).not.toBeNull();
      expect(typeof hooks[0]).toBe('object');
      if (file !== 'format-police.ts') {
        expect(Object.values(hooks[0] as Record<string, unknown>).some((hook) =>
          typeof hook === 'function'
        )).toBe(true);
      }
    });
  }
});

// The police hooks wired by hooks/claude/settings.json — exactly what the plugin
// must re-wire under ${CLAUDE_PLUGIN_ROOT}.
const PRE_TOOL_USE_HOOKS = [
  'git-police.sh',
  'issue-police.sh',
  'kubectl-police.sh',
  'pkg-police.sh',
  'pages-police.sh',
  'mr-police.sh',
  'resource-police.sh',
  'taste-police.sh',
  'prose-police.sh',
];
// Not a Bash gate: it judges the content an Edit or Write is about to land.
const PRE_TOOL_USE_WRITE_HOOKS = ['plan-police.sh'];
const POST_TOOL_USE_HOOKS = ['format-police.sh', 'coding-police.sh', 'comment-police.sh', 'prose-police.sh'];
const ALL_POLICE_HOOKS = [...PRE_TOOL_USE_HOOKS, ...PRE_TOOL_USE_WRITE_HOOKS, ...POST_TOOL_USE_HOOKS];
// The merge gate is consent-gated: it ships in agentkit-adversarial-review, never in core.
const REVIEW_HOOKS = ['fail-closed-hook.sh', 'review-police.sh'];
// The vault is the opt-in half of brain. taste-police is core with the taste
// skill: it carries no rules of its own, so it refuses nothing until the owner
// writes a taste at enforce: block.
const BRAIN_HOOKS = ['memory-index.sh', 'memory-inject.sh'];

function readJson(...parts: string[]): any {
  return JSON.parse(readFileSync(join(pluginDir, ...parts), 'utf-8'));
}

function readReviewJson(...parts: string[]): any {
  return JSON.parse(readFileSync(join(reviewPluginDir, ...parts), 'utf-8'));
}

function readMemoryJson(...parts: string[]): any {
  return JSON.parse(readFileSync(join(memoryPluginDir, ...parts), 'utf-8'));
}

function owningPlugin(command: string): 'core' | 'adversarial-review' | 'brain' {
  if (command.includes('review-police.sh')) return 'adversarial-review';
  if (BRAIN_HOOKS.some((script) => command.includes(script))) return 'brain';
  return 'core';
}

function wiringFor(settings: any, plugin: 'core' | 'adversarial-review' | 'brain'): any {
  const hooks: Record<string, unknown[]> = {};
  for (const [event, kits] of Object.entries<any[]>(settings.hooks)) {
    const kept = kits
      .map((kit) => ({
        ...kit,
        hooks: kit.hooks.filter(
          (entry: { command: string }) => owningPlugin(entry.command) === plugin,
        ),
      }))
      .filter((kit) => kit.hooks.length > 0);
    if (kept.length > 0) hooks[event] = kept;
  }
  return { hooks };
}

function commandBasenames(entries: { command: string }[]): string[] {
  return entries.map((entry) => basename(entry.command));
}

describe('agentkit plugin manifest', () => {
  test('plugin.json declares agentkit without duplicating its standard hooks path', () => {
    const plugin = readJson('.claude-plugin', 'plugin.json');
    expect(plugin.name).toBe('agentkit');
    expect(plugin.version).toBe('0.3.1');
    // Claude automatically loads hooks/hooks.json. Declaring that same path in
    // the manifest makes a fresh install appear enabled while hook loading
    // fails with "Duplicate hooks file detected".
    expect(plugin.hooks).toBeUndefined();
    expect(plugin.skills).toBe('./skills/');
    expect(plugin.mcpServers).toBe('./.mcp.json');
  });
});

describe('agentkit plugin hooks', () => {
  test('hooks.json wires exactly the police hooks under ${CLAUDE_PLUGIN_ROOT}', () => {
    const hooks = readJson('hooks', 'hooks.json').hooks;

    // Two blocks: the Bash gates, and the write gates that judge file content.
    // The merge-shaped matcher exists only to reach review-police, so it leaves
    // with it.
    expect(hooks.PreToolUse).toHaveLength(2);
    expect(hooks.PreToolUse[0].matcher).toBe('Bash');
    expect(commandBasenames(hooks.PreToolUse[0].hooks).sort()).toEqual([...PRE_TOOL_USE_HOOKS].sort());
    expect(hooks.PreToolUse[1].matcher).toBe('Edit|Write');
    expect(commandBasenames(hooks.PreToolUse[1].hooks).sort()).toEqual([...PRE_TOOL_USE_WRITE_HOOKS].sort());

    expect(hooks.PostToolUse).toHaveLength(1);
    expect(hooks.PostToolUse[0].matcher).toBe('Edit|Write');
    expect(commandBasenames(hooks.PostToolUse[0].hooks).sort()).toEqual([...POST_TOOL_USE_HOOKS].sort());

    // Every command must resolve inside the plugin, never a ~/.claude path.
    const allEntries = [...hooks.PreToolUse.flatMap((group: any) => group.hooks), ...hooks.PostToolUse[0].hooks];
    for (const entry of allEntries) {
      expect(entry.command).toStartWith('${CLAUDE_PLUGIN_ROOT}/hooks/');
      expect(entry.command).not.toContain('.claude/hooks');
      expect(entry.type).toBe('command');
      expect(typeof entry.timeout).toBe('number');
      for (const script of REVIEW_HOOKS) expect(entry.command).not.toContain(script);
    }
  });

  test('mirrors every global hook event with plugin-relative commands', () => {
    const source = readFileSync(join(repoRoot, 'hooks', 'claude', 'settings.json'), 'utf-8');
    const expected = JSON.parse(source.replaceAll('$HOME/.claude', '${CLAUDE_PLUGIN_ROOT}'));

    // settings.json stays the whole wiring; the plugins split it, and every
    // entry has to land in exactly one of them.
    expect(readJson('hooks', 'hooks.json')).toEqual(wiringFor(expected, 'core'));
    expect(readReviewJson('hooks', 'hooks.json')).toEqual(wiringFor(expected, 'adversarial-review'));
    expect(readMemoryJson('hooks', 'hooks.json')).toEqual(wiringFor(expected, 'brain'));
  });

  test('every referenced police script exists and is executable', () => {
    // hooks.json must reference these and they must be present + runnable.
    const referenced = new Set(
      readJson('hooks', 'hooks.json').hooks.PreToolUse
        .flatMap((group: { hooks: { command: string }[] }) => group.hooks)
        .concat(readJson('hooks', 'hooks.json').hooks.PostToolUse[0].hooks)
        .map((entry: { command: string }) => basename(entry.command)),
    );

    for (const script of ALL_POLICE_HOOKS) {
      expect(referenced.has(script), `${script} referenced in hooks.json`).toBe(true);
      const mode = statSync(join(pluginDir, 'hooks', script)).mode;
      expect((mode & 0o111) !== 0, `${script} is executable`).toBe(true);
    }

    // The review plugin wires both of its scripts in one command: the
    // supervisor runs review-police, so a basename check would miss the former.
    const reviewCommands: string[] = readReviewJson('hooks', 'hooks.json').hooks.PreToolUse
      .flatMap((kit: any) => kit.hooks.map((entry: { command: string }) => entry.command));
    for (const script of REVIEW_HOOKS) {
      expect(
        reviewCommands.every((command) => command.includes(`/${script}`)),
        `${script} referenced in hooks.json`,
      ).toBe(true);
      const mode = statSync(join(reviewPluginDir, 'hooks', script)).mode;
      expect((mode & 0o111) !== 0, `${script} is executable`).toBe(true);
    }
  });

  test('keeps every source hook byte-identical in the plugin mirror', () => {
    const sourceHooks = join(repoRoot, 'hooks', 'claude');
    const sourceScripts = readdirSync(sourceHooks).filter((name) => name.endsWith('.sh')).sort();
    const coreScripts = sourceScripts.filter(
      (name) => !REVIEW_HOOKS.includes(name) && !BRAIN_HOOKS.includes(name),
    );
    expect(coreScripts).not.toEqual(sourceScripts);

    for (const [dir, scripts] of [
      [pluginDir, coreScripts],
      [reviewPluginDir, [...REVIEW_HOOKS].sort()],
      [memoryPluginDir, [...BRAIN_HOOKS].sort()],
    ] as [string, string[]][]) {
      const pluginScripts = readdirSync(join(dir, 'hooks'))
        .filter((name) => name.endsWith('.sh'))
        .sort();
      expect(pluginScripts).toEqual(scripts);
      for (const script of scripts) {
        expect(readFileSync(join(dir, 'hooks', script), 'utf-8')).toBe(
          readFileSync(join(sourceHooks, script), 'utf-8'),
        );
        expect(statSync(join(dir, 'hooks', script)).mode & 0o111, `${script} is executable`)
          .not.toBe(0);
      }
    }
  });
});

describe('agentkit-adversarial-review plugin', () => {
  test('hooks.json routes Bash and merge-shaped tools through the fail-closed supervisor', () => {
    const hooks = readReviewJson('hooks', 'hooks.json').hooks;

    // Bash block, plus a block matching merge-shaped tool names so MCP merge
    // tools actually reach review-police (its MCP branch was unreachable dead
    // code while only the Bash matcher existed).
    expect(Object.keys(hooks)).toEqual(['PreToolUse']);
    expect(hooks.PreToolUse).toHaveLength(2);
    expect(hooks.PreToolUse[0].matcher).toBe('Bash');
    // Assert what the matcher DOES, not how it is spelled: it must route real
    // MCP merge tool names to review-police and leave everything else alone.
    const routes = new RegExp(hooks.PreToolUse[1].matcher);
    expect(routes.test('mcp__github__merge_pull_request')).toBe(true);
    expect(routes.test('mcp__gitlab__merge_merge_request')).toBe(true);
    expect(routes.test('Bash')).toBe(false);
    expect(routes.test('Edit')).toBe(false);

    for (const kit of hooks.PreToolUse) {
      expect(commandBasenames(kit.hooks)).toEqual(['review-police.sh']);
      expect(kit.hooks[0].command).toStartWith(
        '${CLAUDE_PLUGIN_ROOT}/hooks/fail-closed-hook.sh 45 ',
      );
      expect(kit.hooks[0].command).not.toContain('.claude/hooks');
      expect(kit.hooks[0].type).toBe('command');
    }
  });

  test('carries the review skill and tools the core plugin no longer ships', () => {
    expect(readReviewJson('.claude-plugin', 'plugin.json').name).toBe('agentkit-adversarial-review');
    expect(statSync(join(reviewPluginDir, 'skills', 'adversarial-review', 'SKILL.md')).isFile())
      .toBe(true);
    expect(existsSync(join(pluginDir, 'skills', 'adversarial-review'))).toBe(false);

    for (const tool of ['review-gate', 'review-profile']) {
      const bundled = join(reviewPluginDir, 'tools', tool);
      expect(readFileSync(bundled, 'utf-8')).toBe(readFileSync(join(repoRoot, 'tools', tool), 'utf-8'));
      expect(statSync(bundled).mode & 0o111).not.toBe(0);
      expect(existsSync(join(pluginDir, 'tools', tool))).toBe(false);
    }
    expect(existsSync(join(reviewPluginDir, 'hooks', 'lib', 'hook-input.sh'))).toBe(true);
  });
});

describe('agentkit plugin MCP servers', () => {
  test('.mcp.json declares both the assay and infra-tools servers', () => {
    const servers = readJson('.mcp.json').mcpServers;
    expect(Object.keys(servers).sort()).toEqual(['assay', 'infra-tools']);

    expect(servers.assay.command).toBe('assay');
    expect(servers.assay.args).toEqual(['mcp-serve']);

    expect(servers['infra-tools'].command).toBe('bun');
    // The bundled server must live inside this plugin (plugins are cached as
    // copied files — a cross-plugin path would not survive install).
    expect(servers['infra-tools'].args).toEqual(['${CLAUDE_PLUGIN_ROOT}/server/index.ts']);
  });
});

describe('agentkit plugin skills', () => {
  test('ships the core agentkit skills, each with a SKILL.md', () => {
    const expectedSkills = [
      'autonomous-workflow',
      'code-quality',
      'documentation',
      'gitops-master',
      'issue-raiser',
      'project-planning',
      'resource-safe-execution',
      'test-driven-development',
    ];
    for (const skill of expectedSkills) {
      const skillMd = join(pluginDir, 'skills', skill, 'SKILL.md');
      expect(statSync(skillMd).isFile(), `${skill}/SKILL.md exists`).toBe(true);
    }
  });

  test('gives every skill-bearing kit its own plugin, generated from the manifest', () => {
    const manifest = readSkillKits(repoRoot);
    expect(manifest.kits.map((kit) => kit.id)).toContain('core');

    for (const kit of manifest.kits.filter((g) => kitHasSkills(manifest, repoRoot, g.id))) {
      const dir = join(repoRoot, 'plugins-cc', pluginIdFor(kit.id));
      const plugin = JSON.parse(readFileSync(join(dir, '.claude-plugin', 'plugin.json'), 'utf-8'));
      expect(plugin.name, `${kit.id} plugin name`).toBe(pluginIdFor(kit.id));
      // A skill lands in exactly one plugin; two copies is a double listing in
      // Claude Code and a second copy to rot. What makes a directory a listing
      // is its SKILL.md — a carried dependency has none and lists nowhere.
      const listed = readdirSync(join(dir, 'skills'))
        .filter((name) => existsSync(join(dir, 'skills', name, 'SKILL.md')));
      expect(listed.sort()).toEqual(skillsInKit(manifest, repoRoot, kit.id));
    }
  });

  // A skill importing across kit boundaries needs its dependency shipped
  // alongside, or the relative import cannot resolve where the plugin installs.
  // What rides along stays a copy of the canonical file and stays unlisted.
  test('a carried dependency is an unlisted, byte-identical leaf', () => {
    const manifest = readSkillKits(repoRoot);
    let carried = 0;
    for (const kit of manifest.kits.filter((g) => kitHasSkills(manifest, repoRoot, g.id))) {
      const skillsDir = join(repoRoot, 'plugins-cc', pluginIdFor(kit.id), 'skills');
      const declared = new Set(skillsInKit(manifest, repoRoot, kit.id));
      for (const name of readdirSync(skillsDir).filter((n) => !declared.has(n))) {
        expect(existsSync(join(skillsDir, name, 'SKILL.md')), `${name} would list as a skill`).toBe(false);
        for (const file of filesUnder(join(skillsDir, name))) {
          carried += 1;
          expect(
            readFileSync(join(skillsDir, name, file), 'utf-8'),
            `${name}/${file} drifted from its canonical copy`,
          ).toBe(readFileSync(join(repoRoot, 'skills', name, file), 'utf-8'));
        }
      }
    }
    expect(carried, 'the cross-kit import has no carried dependency').toBeGreaterThan(0);
  });

  test('lists every generated kit plugin in the marketplace', () => {
    const manifest = readSkillKits(repoRoot);
    const marketplace = JSON.parse(
      readFileSync(join(repoRoot, '.claude-plugin', 'marketplace.json'), 'utf-8'),
    );
    const byName = new Map<string, any>(
      marketplace.plugins.map((plugin: any) => [plugin.name, plugin]),
    );

    for (const kit of manifest.kits) {
      const id = pluginIdFor(kit.id);
      const entry = byName.get(id);
      if (!kitHasSkills(manifest, repoRoot, kit.id)) {
        // Skills are the whole payload of a generated kit plugin. A kit that
        // gates an instruction alone has none, and an entry for it would offer a
        // plugin that installs nothing.
        expect(entry, `${id} publishes an empty plugin`).toBeUndefined();
        expect(
          existsSync(join(repoRoot, 'plugins-cc', id)),
          `${id} has a plugin tree with no skills to carry`,
        ).toBe(false);
        continue;
      }
      expect(entry, `${id} is published in the marketplace`).toBeDefined();
      expect(entry.source).toBe(`./plugins-cc/${id}`);
    }
    // Third-party sources are not ours to regenerate.
    expect(byName.has('assay')).toBe(true);
    expect(byName.has('infra-tools')).toBe(true);
  });

  test('keeps every skill byte-identical between skills/ and the plugin mirror', () => {
    // The hooks had this check; the skills did not — and they drifted. The
    // top-level copy of autonomous-workflow was missing the whole review-gate
    // section that shipped to the plugin copy in #78, silently, for as long as
    // nobody diffed them. Two copies with no mechanical check is one rotting
    // copy waiting to be read by someone.
    const sourceSkills = join(repoRoot, 'skills');
    const manifest = readSkillKits(repoRoot);

    for (const kit of manifest.kits) {
      const kitDir = join(repoRoot, 'plugins-cc', pluginIdFor(kit.id), 'skills');
      for (const name of skillsInKit(manifest, repoRoot, kit.id)) {
        const files = filesUnder(join(sourceSkills, name)).sort();
        expect(filesUnder(join(kitDir, name)).sort(), `${name}: file list differs`)
          .toEqual(files);
        for (const file of files) {
          expect(
            readFileSync(join(kitDir, name, file), 'utf-8'),
            `${name}/${file} differs between skills/ and the plugin mirror`,
          ).toBe(readFileSync(join(sourceSkills, name, file), 'utf-8'));
        }
      }
    }
  });

  test('a gitignored build artifact present on only one side does not break parity', () => {
    // skills/diagram/renderer/bundle.js is gitignored on both sides and
    // SKILL.md tells the author to build it locally, so a fresh clone that
    // builds it and never runs sync-cc-plugin.sh has it on the source side
    // only. filesUnder must not see it on either side, so the file-list
    // comparison stays unaffected.
    const source = join(repoRoot, 'skills', 'diagram', 'renderer');
    const mirror = join(repoRoot, 'plugins-cc', 'agentkit', 'skills', 'diagram', 'renderer');
    const artifact = join(source, 'bundle.js');
    const hadArtifact = existsSync(artifact);
    if (!hadArtifact) writeFileSync(artifact, '// build artifact, not tracked by git\n');
    try {
      expect(existsSync(join(mirror, 'bundle.js'))).toBe(false);
      expect(filesUnder(source)).not.toContain('bundle.js');
      expect(filesUnder(source).sort()).toEqual(filesUnder(mirror).sort());
    } finally {
      if (!hadArtifact) rmSync(artifact);
    }
  });
});

describe('agentkit plugin tools', () => {
  test('bundles the portable tools and keeps them executable', () => {
    for (const tool of ['bounded-run']) {
      const bundled = join(pluginDir, 'tools', tool);
      expect(readFileSync(bundled, 'utf-8')).toBe(
        readFileSync(join(repoRoot, 'tools', tool), 'utf-8'),
      );
      expect(statSync(bundled).mode & 0o111).not.toBe(0);
    }
  });
});

describe('marketplace lists the agentkit plugin', () => {
  test('agentkit is present, first, and the granular plugins remain', () => {
    const marketplace = JSON.parse(
      readFileSync(join(repoRoot, '.claude-plugin', 'marketplace.json'), 'utf-8'),
    );
    const names = marketplace.plugins.map((p: { name: string }) => p.name);
    // Recommended one-shot first, then the à-la-carte plugins, then the
    // manifest-generated kit plugins appended by sync-cc-plugin.sh.
    const manifest = readSkillKits(repoRoot);
    const generated = manifest.kits
      .filter((kit) => kit.id !== 'core' && kitHasSkills(manifest, repoRoot, kit.id))
      .map((kit) => pluginIdFor(kit.id));
    expect(names).toEqual(['agentkit', 'assay', 'infra-tools', ...generated]);

    const agentkit = marketplace.plugins.find((p: { name: string }) => p.name === 'agentkit');
    expect(agentkit.source).toBe('./plugins-cc/agentkit');
    expect(agentkit.version).toBe(readJson('.claude-plugin', 'plugin.json').version);
    expect(agentkit.version).toBe('0.3.1');
    expect(agentkit.description).toContain('bounded-run');
    expect(agentkit.description).toContain('agent-work.slice');
    expect(agentkit.description).toContain('Linux bounded execution additionally requires');
    expect(agentkit.description).not.toContain('Requires jq, bun, assay, cgroup v2');
  });
});

// Reuse of the infra-tools server integration coverage against the COPY bundled
// inside the agentkit plugin: prove the server still boots and lists its tools
// from its new location (this is the smoke test the plugin depends on).
describe('bundled infra-tools server (copied into the agentkit plugin)', () => {
  const SERVER = join(pluginDir, 'server', 'index.ts');

  interface RpcResponse {
    jsonrpc: string;
    id: number | string | null;
    result?: any;
    error?: { code: number; message: string };
  }

  async function rpc(requests: object[]): Promise<RpcResponse[]> {
    const proc = Bun.spawn(['bun', SERVER], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
    proc.stdin.write(requests.map((r) => JSON.stringify(r)).join('\n') + '\n');
    await proc.stdin.end();
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    return out.trim().split('\n').filter((l) => l.length > 0).map((l) => JSON.parse(l) as RpcResponse);
  }

  const initialize = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 't', version: '0' },
    },
  };

  test('initialize + tools/list works from the bundled copy', async () => {
    const responses = await rpc([initialize, { jsonrpc: '2.0', id: 2, method: 'tools/list' }]);

    const init = responses.find((r) => r.id === 1)!;
    expect(init.error).toBeUndefined();
    expect(init.result.serverInfo).toEqual({ name: 'infra-tools', version: '0.1.0' });

    const list = responses.find((r) => r.id === 2)!;
    const names: string[] = list.result.tools.map((t: { name: string }) => t.name);
    expect(names.sort()).toEqual([
      'git_clone_ro',
      'git_diff',
      'git_log',
      'git_status',
      'helm_get_values',
      'helm_list',
      'helm_template',
      'tofu_plan',
      'tofu_show',
      'tofu_state_list',
    ]);
    // No mutating escape hatch leaked into the bundled copy.
    expect(names.some((n) => /apply|install|upgrade|uninstall|destroy|push|commit|reset/.test(n)))
      .toBe(false);
  });
});

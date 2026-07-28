import { describe, expect, test } from 'bun:test';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = dirname(dirname(import.meta.dir));
const hook = join(repoRoot, 'hooks', 'claude', 'pages-police.sh');

function runHook(command: string, env: Record<string, string> = {}): string {
  return spawnSync('bash', [hook], {
    input: JSON.stringify({ tool_input: { command } }),
    encoding: 'utf-8',
    env: { ...process.env, AGENTKIT_ALLOW_BARE_SVG: '', ...env },
  }).stdout ?? '';
}

describe('pages-police: direct API writes', () => {
  const denied = [
    'curl -X PUT https://pages.agentkit.sbs/api/pages/abc --data @page.html',
    'curl --upload-file page.html https://pages.agentkit.sbs/api/pages/abc',
    'curl -T page.html https://pages.agentkit.sbs/api/pages/abc',
    'curl -X DELETE https://pages.agentkit.sbs/api/pages/abc',
    'curl --request DELETE https://pages.agentkit.sbs/api/pages/abc',
    'curl --request PUT --json @p.html https://pages.agentkit.sbs/api/pages/abc',
    'wget --method=PUT --body-file=p.html http://127.0.0.1:8787/api/pages/abc',
    'http PUT pages.agentkit.sbs/api/pages/abc < page.html',
    'xh DELETE pages.agentkit.sbs/api/pages/abc',
    'sh -c "http PUT pages.agentkit.sbs/api/pages/abc < page.html"',
  ];
  for (const command of denied) {
    test(`denies: ${command.slice(0, 60)}`, () => {
      const out = runHook(command);
      expect(out).toContain('"permissionDecision": "deny"');
      expect(out).toContain('publish.ts');
    });
  }

  const allowed = [
    'curl https://pages.agentkit.sbs/api/pages/abc',
    'curl -I https://pages.agentkit.sbs/api/pages/abc',
    'bun skills/publish-page/publish.ts --name x --file page.md',
    'bun skills/publish-page/publish.ts --name x --delete',
    'curl -X PUT https://other.example/v1/items -d x=1',
  ];
  for (const command of allowed) {
    test(`allows: ${command.slice(0, 60)}`, () => {
      expect(runHook(command)).not.toContain('deny');
    });
  }
});

describe('pages-police: --allow-bare-svg needs user approval', () => {
  const publish = 'bun skills/publish-page/publish.ts --name x --file p.md --allow-bare-svg';

  test('denied without the override', () => {
    const out = runHook(publish);
    expect(out).toContain('"permissionDecision": "deny"');
    expect(out).toContain('AGENTKIT_ALLOW_BARE_SVG=1');
  });

  test('inline override allows it', () => {
    expect(runHook(`AGENTKIT_ALLOW_BARE_SVG=1 ${publish}`)).not.toContain('deny');
  });

  test('environment override allows it', () => {
    expect(runHook(publish, { AGENTKIT_ALLOW_BARE_SVG: '1' })).not.toContain('deny');
  });

  test('an override token buried in a string does not count', () => {
    expect(runHook(`echo AGENTKIT_ALLOW_BARE_SVG=1x; ${publish}`)).toContain('deny');
  });
});

describe('pages-police: harness compatibility', () => {
  test('empty and non-bash payloads pass through silently', () => {
    expect(runHook('')).not.toContain('deny');
    const out = spawnSync('bash', [hook], { input: '{}', encoding: 'utf-8' }).stdout ?? '';
    expect(out).not.toContain('deny');
  });
});

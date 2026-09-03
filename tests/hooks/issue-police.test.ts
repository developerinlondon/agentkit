import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOOK = join(import.meta.dir, '..', '..', 'hooks', 'claude', 'issue-police.sh');

const DISPOSITION = 'Disposition: owner-deferred — the owner said this waits';

let root: string;

function runHook(command: string, cwd?: string): string {
  const res = spawnSync('bash', [HOOK], {
    cwd: cwd ?? root,
    input: JSON.stringify({ tool_input: { command } }),
    encoding: 'utf-8',
  });
  return res.stdout ?? '';
}

function denied(command: string, cwd?: string): boolean {
  return runHook(command, cwd).includes('"deny"');
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'agentkit-issuepolice-'));
});

afterAll(() => {
  rmSync(root, { force: true, recursive: true });
});

describe('issue-police: the disposition line is required', () => {
  test('a GitHub issue with no disposition is refused', () => {
    const out = runHook('gh issue create --title "flaky test" --body "it fails sometimes"');
    expect(out).toContain('"deny"');
    expect(out).toContain('why it is being filed rather than fixed');
  });

  test('a GitLab issue with no disposition is refused', () => {
    expect(denied('glab issue create --title "flaky test" --description "it fails"')).toBe(true);
  });

  test('an interactive create with no body at all is refused', () => {
    expect(denied('gh issue create --title "flaky test"')).toBe(true);
  });

  test('a bare marker with nothing after it is not a way through', () => {
    expect(denied('gh issue create --title x --body "Disposition:"')).toBe(true);
    expect(denied('gh issue create --title x --body "Disposition:   "')).toBe(true);
  });
});

describe('issue-police: every disposition the refusal offers actually works', () => {
  // The refusal names example lines. Each one is lifted straight out of the
  // message and replayed, so the hook cannot suggest a form its own parser
  // rejects — the whole point of a refusal that tells you what to do.
  const refusal = runHookOnce();

  function runHookOnce(): string {
    const res = spawnSync('bash', [HOOK], {
      cwd: tmpdir(),
      input: JSON.stringify({ tool_input: { command: 'gh issue create --title x' } }),
      encoding: 'utf-8',
    });
    return res.stdout ?? '';
  }

  const examples = [...refusal.matchAll(/ {2}(Disposition: [^"\\]+?)\\n/g)].map((m) => m[1]);

  test('the refusal offers examples at all', () => {
    expect(examples.length).toBeGreaterThanOrEqual(3);
  });

  for (const example of examples) {
    test(`"${example}" passes`, () => {
      expect(denied(`gh issue create --title x --body "${example}"`)).toBe(false);
    });
  }
});

describe('issue-police: where the disposition may live', () => {
  test('inline in the body', () => {
    expect(denied(`gh issue create --title x --body "${DISPOSITION}"`)).toBe(false);
  });

  test('in a --body-file the hook can read', () => {
    const body = join(root, 'body.md');
    writeFileSync(body, `Some detail.\n\n${DISPOSITION}\n`);
    expect(denied(`gh issue create --title x --body-file ${body}`)).toBe(false);
  });

  test('a --body-file without the line is still refused', () => {
    const body = join(root, 'nodisp.md');
    writeFileSync(body, 'Some detail with no disposition at all.\n');
    expect(denied(`gh issue create --title x --body-file ${body}`)).toBe(true);
  });

  test('a relative --body-file resolves against a cd prefix, not the hook cwd', () => {
    const dir = join(root, 'elsewhere');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'issue.md'), `${DISPOSITION}\n`);
    expect(denied(`cd ${dir} && gh issue create --title x --body-file issue.md`)).toBe(false);
  });

  test('a heredoc body carries it too', () => {
    const command = `gh issue create --title x --body "$(cat <<'EOF'
Root cause: unknown.

Disposition: blocked-by a schema decision the team has not made yet
EOF
)"`;
    expect(denied(command)).toBe(false);
  });

  test('a body piped in on stdin cannot be read, and the refusal says so', () => {
    const out = runHook('cat body.md | gh issue create --title x --body-file -');
    expect(out).toContain('"deny"');
    expect(out).toContain('stdin');
  });

  test('the short -F form is read as a body file', () => {
    const body = join(root, 'shortflag.md');
    writeFileSync(body, `${DISPOSITION}\n`);
    expect(denied(`gh issue create --title x -F ${body}`)).toBe(false);
  });
});

describe('issue-police: what it does not touch', () => {
  const untouched = [
    'gh issue list --author @me',
    'gh issue comment 12 --body "no disposition here"',
    'gh issue close 12 --reason completed',
    'gh pr create --title x --body "no disposition here"',
    'glab mr create --title x --assignee @me',
    'glab issue list',
    'git commit -m "gh issue create"',
  ];

  for (const command of untouched) {
    test(`${command} passes untouched`, () => {
      expect(runHook(command).trim()).toBe('');
    });
  }
});

describe('issue-police: harness compatibility', () => {
  test('a Grok camelCase payload is read the same way', () => {
    const res = spawnSync('bash', [HOOK], {
      cwd: root,
      input: JSON.stringify({ toolName: 'bash', toolInput: { command: 'gh issue create -t x' } }),
      encoding: 'utf-8',
    });
    expect(res.stdout ?? '').toContain('"deny"');
  });
});

describe('issue-police: the REST spelling of a creation', () => {
  const url = '"projects/GTI%2Fgroup%2Frepo/issues"';

  test('glab api POST to an issues collection with no disposition is refused', () => {
    expect(denied(`glab api --method POST ${url} --field title="broken thing"`)).toBe(true);
  });

  test('the -X spelling is refused too', () => {
    expect(denied(`glab api -X POST ${url} --field title="broken thing"`)).toBe(true);
  });

  test('gh api POST to an issues collection is refused', () => {
    expect(denied('gh api --method POST /repos/o/r/issues -f title="broken thing"')).toBe(true);
  });

  test('a disposition in the field body passes', () => {
    expect(
      denied(
        `glab api --method POST ${url} --field description="${DISPOSITION}"`,
      ),
    ).toBe(false);
  });

  test('posting a NOTE to an existing issue is not a creation', () => {
    expect(denied('glab api --method POST "projects/g%2Fr/issues/140/notes" --field body="an update"')).toBe(
      false,
    );
  });

  test('an issues URL quoted inside a description is not a creation', () => {
    expect(
      denied('glab api --method POST "projects/g%2Fr/merge_requests" --field description="see /issues"'),
    ).toBe(false);
  });

  test('reading issues is not a creation', () => {
    expect(denied('glab api "projects/g%2Fr/issues?state=opened"')).toBe(false);
  });

  test('updating an issue is not a creation', () => {
    expect(denied('glab api --method PUT "projects/g%2Fr/issues/140" --field labels="bug"')).toBe(false);
  });
});

function withConfig(body: string, command: string): boolean {
  const home = mkdtempSync(join(tmpdir(), 'agentkit-issuecfg-'));
  try {
    mkdirSync(join(home, 'agentkit'), { recursive: true });
    writeFileSync(join(home, 'agentkit', 'config.yaml'), body);
    const res = spawnSync('bash', [HOOK], {
      cwd: root,
      input: JSON.stringify({ tool_input: { command } }),
      encoding: 'utf-8',
      env: { ...process.env, XDG_CONFIG_HOME: home, CLAUDE_PROJECT_DIR: root },
    });
    return (res.stdout ?? '').includes('"deny"');
  } finally {
    rmSync(home, { force: true, recursive: true });
  }
}

describe('issue-police: an issue that says nothing is not an issue', () => {
  test('a title with no description is refused even when the disposition is in the title', () => {
    const out = runHook(`gh issue create --title "${DISPOSITION}"`);
    expect(out).toContain('"deny"');
    expect(out).toContain('no description');
  });

  test('a template pasted with its guidance comments still in it is refused', () => {
    const out = runHook(
      `glab issue create -R o/r -t x --description "${DISPOSITION}\n\n## Description\n<!-- one sentence -->\n"`,
    );
    expect(out).toContain('unfilled template');
  });

  test('an empty checkbox is an unanswered section', () => {
    expect(
      denied(`glab issue create -R o/r -t x --description "${DISPOSITION}\n\n## Criteria\n- [ ]\n"`),
    ).toBe(true);
  });

  test('a placeholder quick action is refused', () => {
    expect(denied(`glab issue create -R o/r -t x --description "${DISPOSITION}\n\n/milestone %\n"`)).toBe(
      true,
    );
  });

  test('a filled body with real checkboxes passes', () => {
    expect(
      denied(
        `glab issue create -R o/r -t x --description "${DISPOSITION}\n\n## Criteria\n- [ ] the poller sees threaded events\n"`,
      ),
    ).toBe(false);
  });
});

describe('issue-police: the body bounds are the project’s to set', () => {
  const short = `glab issue create -R o/r -t x --description "${DISPOSITION}"`;

  test('no floor is configured, so a short body passes', () => {
    expect(denied(short)).toBe(false);
  });

  test('a configured floor refuses the same body', () => {
    expect(withConfig('issue-police:\n  min-body-chars: 400\n', short)).toBe(true);
  });

  test('a configured ceiling refuses a wall of prose', () => {
    const long = `glab issue create -R o/r -t x --description "${DISPOSITION}. ${'word '.repeat(400)}"`;
    expect(withConfig('issue-police:\n  max-body-chars: 500\n', long)).toBe(true);
    expect(denied(long)).toBe(false);
  });
});

describe('issue-police: required metadata', () => {
  const bare = `glab issue create -R o/r -t x --description "${DISPOSITION} and here is the detail"`;

  test('nothing is required by default', () => {
    expect(denied(bare)).toBe(false);
  });

  test('a required field the command omits is refused, naming it', () => {
    expect(withConfig('issue-police:\n  require: milestone\n', bare)).toBe(true);
    expect(withConfig('issue-police:\n  require: assignee\n', `${bare} --milestone "Aug"`)).toBe(true);
  });

  test('the requirement is satisfied by passing the flag', () => {
    expect(
      withConfig('issue-police:\n  require: milestone,assignee\n', `${bare} --milestone "Aug" --assignee sam`),
    ).toBe(false);
  });
});

// A gate that cannot read its subject must not refuse it. Without python3 the
// shlex parser is gone, so the body and flags are indistinguishable from prose
// that mentions them — and denying there blocks every issue on the host.
describe('issue-police: no parser means no opinion', () => {
  function withoutPython(command: string): string {
    const bin = mkdtempSync(join(tmpdir(), 'agentkit-nopython-'));
    try {
      for (const tool of ['bash', 'grep', 'sed', 'jq', 'cat', 'wc', 'tr', 'awk', 'head', 'date']) {
        const found = spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf-8' }).stdout?.trim();
        if (found) symlinkSync(found, join(bin, tool));
      }
      const res = spawnSync('bash', [HOOK], {
        cwd: root,
        input: JSON.stringify({ tool_input: { command } }),
        encoding: 'utf-8',
        env: { PATH: bin, HOME: root },
      });
      return res.stdout ?? '';
    } finally {
      rmSync(bin, { force: true, recursive: true });
    }
  }

  const filed = `glab issue create -R o/r -t x --description "${DISPOSITION} and the detail"`;

  test('an issue is allowed through when python3 is absent', () => {
    const out = withoutPython(filed);
    expect(out).not.toContain('"deny"');
  });

  test('and it says so, rather than passing silently as if it had checked', () => {
    expect(withoutPython(filed)).toContain('UNCHECKED');
  });

  test('the disposition gate still refuses without python3', () => {
    expect(withoutPython('glab issue create -R o/r -t x --description "no disposition here"')).toContain(
      '"deny"',
    );
  });
});

// An issue about templates quotes template markers as evidence. The first
// version of the skeleton check refused exactly that — a real, well-formed
// issue filed against a playbook was blocked for citing the prompt it was
// complaining about.
describe('issue-police: a quoted marker is evidence, not an unfilled section', () => {
  const cited = `${DISPOSITION}

## Description

As an engineer filing an issue, I want the template to ask for the outcome, so
that what I produce is already the right shape.

Context:
- \`default.md:13\` prompts \`<!-- One sentence: what needs to be done? -->\`, and
  the skill says \`Description: One sentence of what needs doing\`.

## Acceptance Criteria

- [ ] the template asks for the outcome line`;

  test('a marker quoted inline in backticks passes', () => {
    expect(denied(`glab issue create -R o/r -t x --description "${cited}"`)).toBe(false);
  });

  test('a marker inside a fenced block passes', () => {
    const fenced = `${DISPOSITION}\n\nThe template reads:\n\n\`\`\`markdown\n<!-- One sentence: what needs to be done? -->\n- [ ]\n\`\`\`\n\nand that is the problem.`;
    expect(denied(`glab issue create -R o/r -t x --description "${fenced}"`)).toBe(false);
  });

  test('a marker that owns its line is still refused', () => {
    const unfilled = `${DISPOSITION}\n\n## Description\n\n<!-- One sentence: what needs to be done? -->\n`;
    expect(denied(`glab issue create -R o/r -t x --description "${unfilled}"`)).toBe(true);
  });

  test('an empty checkbox that owns its line is still refused', () => {
    const unfilled = `${DISPOSITION}\n\n## Criteria\n\n- [ ]\n`;
    expect(denied(`glab issue create -R o/r -t x --description "${unfilled}"`)).toBe(true);
  });
});

// Presence is not enough: the value has to be one of the four accepted
// dispositions. Every case here fails if the value-gate in disposition_form_ok
// is reverted to a presence-only check.
describe('issue-police: the disposition value is gated, not just presence', () => {
  const accepted = [
    'Disposition: owner-deferred — the owner said this waits',
    'Disposition: owner-deferred - the owner said this waits',
    'Disposition: owner-deferred -- the owner said this waits',
    'Disposition: OWNER-DEFERRED — the owner said this waits',
    'Disposition: Owner-Deferred - the owner said this waits',
    'Disposition: owner-request — the owner asked for this to be filed',
    'Disposition: owner-request - the owner asked for this to be filed',
    'Disposition: blocked-by legal sign-off on the license text',
    'Disposition: BLOCKED-BY legal sign-off on the license text',
    'Disposition: in-progress — building the retry queue now, lane B',
    'Disposition: in-progress - building the retry queue now, lane B',
    'Disposition: IN-PROGRESS — building the retry queue now, lane B',
  ];

  for (const line of accepted) {
    test(`accepted: ${line}`, () => {
      expect(denied(`gh issue create --title x --body "${line}"`)).toBe(false);
    });
  }

  test('accepted: the free text may be quoted, as the owner\'s exact words', () => {
    const command = `gh issue create --title x --body 'Disposition: owner-request — "please create a rule so no issue is left out" (2026-09-03).'`;
    expect(denied(command)).toBe(false);
  });

  const refused = [
    'Disposition: follow-up',
    'Disposition: later',
    'Disposition: future',
    'Disposition: non-blocking',
    'Disposition: nice to have',
    'Disposition: tech debt',
    'Disposition: fix later',
    'Disposition: new work, unrelated to anything in flight',
    'Disposition: carved out of #12, deferral approved by the operator',
    'Disposition: owner-deferred —',
    'Disposition: owner-deferred — ',
    'Disposition: blocked-by',
    'Disposition: owner-deferredsomething',
    'Disposition: x',
    'Disposition: in progress later',
    'Disposition: in-progress',
    'Disposition: in-progress —',
  ];

  for (const line of refused) {
    test(`refused: ${line}`, () => {
      const out = runHook(`gh issue create --title x --body "${line}"`);
      expect(out).toContain('"deny"');
      expect(out).toContain('is not a way to end a lane');
    });
  }

  test('a refused value in a --body-file is caught the same way', () => {
    const body = join(root, 'wrongform.md');
    writeFileSync(body, 'Disposition: follow-up, low priority\n');
    const out = runHook(`gh issue create --title x --body-file ${body}`);
    expect(out).toContain('"deny"');
    expect(out).toContain('is not a way to end a lane');
  });

  test('an accepted value in a --body-file passes', () => {
    const body = join(root, 'rightform.md');
    writeFileSync(body, 'Disposition: blocked-by a pending decision from the platform team\n');
    expect(denied(`gh issue create --title x --body-file ${body}`)).toBe(false);
  });

  test('a refused value over the REST field spelling is caught the same way', () => {
    const out = runHook(
      'glab api --method POST "projects/o%2Fr/issues" --field description="Disposition: follow-up"',
    );
    expect(out).toContain('"deny"');
    expect(out).toContain('is not a way to end a lane');
  });

  test('an en-dash separator is accepted alongside the hyphen and em-dash', () => {
    expect(denied('gh issue create --title x --body "Disposition: owner-deferred – the owner said this waits"')).toBe(
      false,
    );
  });
});

// gh/glab's flag parser overwrites a single-value string flag on each repeated
// occurrence, so the LAST --body/--description/--field body= is what the
// forge actually receives — an earlier one is a decoy that must not be read
// as the effective value.
describe('issue-police: a repeated body flag is read the way the forge reads it', () => {
  test('a passing decoy first and the real refused value last is still denied', () => {
    const out = runHook('gh issue create --title x --body "Disposition: owner-deferred — x" --body "Disposition: follow-up"');
    expect(out).toContain('"deny"');
  });

  test('a refused decoy first and the real accepted value last passes', () => {
    expect(
      denied(
        'gh issue create --title x --body "Disposition: follow-up" --body "Disposition: owner-deferred — the real reason"',
      ),
    ).toBe(false);
  });

  test('--description behaves the same as --body', () => {
    const out = runHook(
      'glab issue create -R o/r -t x --description "Disposition: owner-deferred — x" --description "Disposition: follow-up"',
    );
    expect(out).toContain('"deny"');
  });

  test('the REST --field body= spelling: refused value last is denied', () => {
    const out = runHook(
      'glab api --method POST "projects/o%2Fr/issues" --field body="Disposition: owner-deferred — real reason" --field body="Disposition: follow-up"',
    );
    expect(out).toContain('"deny"');
  });

  test('the REST --field body= spelling: accepted value last passes', () => {
    expect(
      denied(
        'glab api --method POST "projects/o%2Fr/issues" --field body="Disposition: follow-up" --field body="Disposition: owner-deferred — real reason"',
      ),
    ).toBe(false);
  });
});

describe('issue-police: a Disposition line that only illustrates the syntax is not an answer', () => {
  test('a Disposition line inside inline backticks is not read as the disposition', () => {
    const body = 'Some text. `Disposition: owner-deferred — x` is the syntax, not a real answer.';
    const out = runHook(`gh issue create --title x --body "${body}"`);
    expect(out).toContain('"deny"');
    expect(out).toContain('why it is being filed rather than fixed');
  });

  test('a Disposition line inside a fenced block is not read as the disposition', () => {
    const body = `See below:\n\n\`\`\`\nDisposition: owner-deferred — example text\n\`\`\`\n\nthat is the syntax to use.`;
    const out = runHook(`gh issue create --title x --body "${body}"`);
    expect(out).toContain('"deny"');
    expect(out).toContain('why it is being filed rather than fixed');
  });

  test('a quoted example followed by the real line still passes, reading the real one', () => {
    const body = 'Example: `Disposition: follow-up` is wrong.\n\nDisposition: owner-deferred — the actual reason';
    expect(denied(`gh issue create --title x --body "${body}"`)).toBe(false);
  });
});

describe('issue-police: AGENTKIT_SKIP_HOOKS', () => {
  const undenied = 'gh issue create --title x --body "no disposition here"';

  function runWithSkip(value: string): string {
    const res = spawnSync('bash', [HOOK], {
      cwd: root,
      input: JSON.stringify({ tool_input: { command: undenied } }),
      encoding: 'utf-8',
      env: { ...process.env, AGENTKIT_SKIP_HOOKS: value },
    });
    return res.stdout ?? '';
  }

  test('AGENTKIT_SKIP_HOOKS=issue-police lets an otherwise-refused creation through', () => {
    expect(runWithSkip('issue-police')).not.toContain('"deny"');
  });

  test('AGENTKIT_SKIP_HOOKS=all lets it through too', () => {
    expect(runWithSkip('all')).not.toContain('"deny"');
  });

  test('a different hook name in the list does not skip issue-police', () => {
    expect(runWithSkip('other-hook')).toContain('"deny"');
  });
});

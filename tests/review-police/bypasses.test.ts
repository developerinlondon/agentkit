import { describe, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { passing } from './commands';
import { HEAD, HOOK } from './constants';
import { bin, home, installFixture, record, repo } from './fixture';
import { runHook, test } from './probe';

installFixture();

// Each of these merged cleanly past the first version of this hook.
describe('review-police: bypasses found in adversarial review', () => {
  test('B1: a pass for one branch does not authorise merging a different MR', () => {
    record(passing); // covers feat/thing
    expect(runHook('glab mr merge 999 --squash --yes')).toContain('"deny"');
  });

  // NOTE: this proves the script's behaviour only. That it is REACHED for MCP
  // calls is a registration fact, asserted in tests/agentkit-plugin.test.ts —
  // the first version of this hook refused MCP merges in code that no matcher
  // ever routed to it, and this test passed anyway.
  test('B2: MCP merge tools are refused by the script', () => {
    const out = runHook('', { tool: 'mcp__github__merge_pull_request' });
    expect(out).toContain('"deny"');
    expect(out).toContain('MCP tool');
  });

  test('push options that queue a merge are refused', () => {
    record(passing);
    for (const cmd of [
      'git push -o merge_request.merge_when_pipeline_succeeds origin feat/thing',
      'git push -omerge_request.merge_when_pipeline_succeeds origin feat/thing',
      'git push --push-option=merge_request.merge_when_pipeline_succeeds origin feat/thing',
      'G=git; $G push -o merge_request.merge_when_pipeline_succeeds origin feat/thing',
    ]) {
      expect(runHook(cmd)).toContain('"deny"');
    }
  });

  test('an assembled forge executable still reaches the standalone-command denial', () => {
    record(passing);
    for (const cmd of [
      'A=g; B=lab; "$A$B" mr merge 12 --yes',
      `part=mr; glab "$part" merge 12 --sha ${HEAD} --auto-merge=false`,
      `group=mr; verb=merge; glab "$group" "$verb" 12 --sha ${HEAD} --auto-merge=false`,
    ]) {
      const out = runHook(cmd);
      expect(out, cmd).toContain('"deny"');
      expect(out, cmd).toContain('standalone forge CLI command');
    }
  });

  test('the supervisor preserves denials for runtime-built merge forms', () => {
    record(passing);
    for (const cmd of [
      'cli=glab; "$cli" mr merge 12 --yes',
      `part=mr; glab "$part" merge 12 --sha ${HEAD} --auto-merge=false`,
      `group=mr; verb=merge; glab "$group" "$verb" 12 --sha ${HEAD} --auto-merge=false`,
      'base=https://api.github.com/repos/o/r/pulls/12; action=merge; curl -X PUT "$base/$action"',
      '/usr/bin/git push -o merge_request.merge_when_pipeline_succeeds origin feat/thing',
      'glab mr merge 12 --auto-merge',
    ]) {
      expect(runHook(cmd, { supervised: true }), cmd).toContain('"deny"');
    }
  });

  test('commands that merely mention the push option are not merges', () => {
    record(passing);
    // `-o` is everywhere, so matching it bare denied ordinary work — including
    // grepping for the very rule this hook enforces. That bit for real: the
    // pre-fix hook blocked the command that was installing its own fix.
    for (const cmd of [
      'grep -o merge_request.merge_when_pipeline_succeeds README.md',
      'rg -o "merge_request.merge" docs/',
      'curl -o merge_request.merge.json https://example.com/x',
      'gcc -o merge_request.merge main.c',
    ]) {
      expect(runHook(cmd)).toBe('');
    }
  });

  test('a push option is caught even behind a flag with its own argument', () => {
    record(passing);
    // `git -C <dir> push` — the guard tolerated flags but not their arguments,
    // the same shape that had already broken MR-id extraction once.
    for (const cmd of [
      'git -C /repo push -o merge_request.merge_when_pipeline_succeeds origin b',
      'git --git-dir=/r/.git push --push-option=merge_request.merge_when_pipeline_succeeds origin b',
    ]) {
      expect(runHook(cmd)).toContain('"deny"');
    }
  });

  test('quoted text is not a command: commit messages describing the rules', () => {
    record(passing);
    // This hook blocked the very commits that were fixing it, three times,
    // because the rule it enforces appeared inside a commit message.
    const msg = 'git commit -m "fix: git push -o merge_request.merge_when_pipeline_succeeds is refused"';
    expect(runHook(msg)).toBe('');
    expect(runHook('git commit -m "docs: glab mr merge 12 is gated" && git push')).toBe('');
  });

  test('a merge URL denies even when only being read', () => {
    record(passing);
    // Deliberate: this used to allow, on the theory that only a recognised HTTP
    // caller counts. That theory WAS the hole — the caller list could never
    // cover every interpreter, so a real merge slipped through as "not a merge".
    // Denying a grep is the cheap failure; missing a merge is the expensive one.
    expect(runHook('grep -rn "merge_requests/999/merge" docs/')).toContain('"deny"');
    expect(runHook('rg "/pulls/999/merge" .')).toContain('"deny"');
  });

  test('a REST merge is gated whatever calls it', () => {
    record(passing);
    // Each of these evaded while the gate required a caller from a fixed list.
    // The python form is not hypothetical: it is how a merge actually reached
    // the forge with no review record.
    const url = 'https://gitlab.com/api/v4/projects/1%2Fp/merge_requests/999/merge';
    for (const cmd of [
      `python3 -c "import urllib.request; urllib.request.urlopen('${url}')"`,
      `node -e "fetch('${url}', {method:'PUT'})"`,
      `ruby -e "Net::HTTP.put(URI('${url}'))"`,
      `perl -e "put('${url}')"`,
      `bun run merge.ts --url '${url}'`,
      // No recognisable client at all — a wrapper script is still a caller.
      `./deploy.sh --endpoint '${url}'`,
    ]) {
      expect(runHook(cmd)).toContain('"deny"');
    }
  });

  test('a passing local record cannot authorise an explicit REST target', () => {
    record(passing);
    // REST endpoints carry their own repository identity. Resolving change 12
    // from the current checkout would let an approved local record authorise a
    // different repository that happens to use the same change number.
    for (const cmd of [
      'gh api --method PUT repos/other/repo/pulls/12/merge',
      'glab api --method PUT projects/999/merge_requests/12/merge',
    ]) {
      const out = runHook(cmd);
      expect(out, cmd).toContain('"deny"');
      expect(out, cmd).toContain('direct REST merge');
    }
  });

  test('GraphQL merge mutations cannot hide in file-backed API payloads', () => {
    record(passing);
    const jsonPayload = join(repo, 'merge-payload.json');
    const escapedJsonPayload = join(repo, 'escaped-merge-payload.json');
    const queryPayload = join(repo, 'merge-query.graphql');
    writeFileSync(
      jsonPayload,
      JSON.stringify({
        query: 'mutation { mergePullRequest(input: { pullRequestId: "x" }) { clientMutationId } }',
      }),
    );
    writeFileSync(
      escapedJsonPayload,
      '{"query":"mutation { merge\\u0050ullRequest(input: { pullRequestId: \\"x\\" }) { clientMutationId } }"}\n',
    );
    writeFileSync(
      queryPayload,
      'mutation { mergeRequestAccept(input: { iid: "12" }) { errors } }\n',
    );

    for (const cmd of [
      `gh api graphql --input ${jsonPayload}`,
      `gh api graphql --input=${jsonPayload}`,
      `gh api graphql --input ${escapedJsonPayload}`,
      `gh api graphql -F query=@${queryPayload}`,
      `gh api graphql --field=query=@${queryPayload}`,
    ]) {
      const out = runHook(cmd);
      expect(out, cmd).toContain('"deny"');
      expect(out, cmd).toContain('indirect GraphQL API payload');
    }
  });

  test('opaque stdin-backed GraphQL API payloads fail closed', () => {
    record(passing);
    const jsonPayload = join(repo, 'stdin-merge-payload.json');
    writeFileSync(
      jsonPayload,
      JSON.stringify({
        query: 'mutation { mergePullRequest(input: { pullRequestId: "x" }) { clientMutationId } }',
      }),
    );

    for (const cmd of [
      `gh api graphql --input - < ${jsonPayload}`,
      `gh api graphql --input /dev/stdin < ${jsonPayload}`,
      `cat ${jsonPayload} | gh api graphql --input -`,
      `gh api graphql -F query=@- < ${jsonPayload}`,
      `endpoint=graphql; gh api "$endpoint" --input ${jsonPayload}`,
      `endpoint=graph; suffix=ql; gh api "$endpoint$suffix" --input - < ${jsonPayload}`,
      `field=query=@${jsonPayload}; gh api graphql -F "$field"`,
      `key=query; gh api graphql -F "$key=@${jsonPayload}"`,
      `flag=--input; gh api graphql "$flag" ${jsonPayload}`,
      `flag=--input=${jsonPayload}; gh api graphql "$flag"`,
      `flag=--field=query=@${jsonPayload}; gh api graphql "$flag"`,
    ]) {
      const out = runHook(cmd);
      expect(out, cmd).toContain('"deny"');
      expect(out, cmd).toContain('indirect GraphQL API payload');
    }
  });

  test('file-backed read-only GraphQL requests also fail closed against payload swaps', () => {
    record(passing);
    const jsonPayload = join(repo, 'safe-payload.json');
    const queryPayload = join(repo, 'safe-query.graphql');
    writeFileSync(
      jsonPayload,
      JSON.stringify({ query: 'query { viewer { login } }', variables: {} }),
    );
    writeFileSync(queryPayload, 'query { viewer { login } }\n');

    for (const cmd of [
      `gh api graphql --input ${jsonPayload}`,
      `gh api graphql -F query=@${queryPayload}`,
    ]) {
      const out = runHook(cmd);
      expect(out, cmd).toContain('"deny"');
      expect(out, cmd).toContain('can change after this check');
    }
  });

  test('safe inline GraphQL queries and ordinary API requests remain allowed', () => {
    record(passing);
    for (const cmd of [
      "gh api graphql -f 'query=query { viewer { login } }'",
      "gh api graphql -F 'query=query { viewer { login } }'",
      "gh api graphql -f 'query=query($login:String!){user(login:$login){id}}' -F login=octocat",
      'gh api repos/owner/repo',
    ]) {
      expect(runHook(cmd), cmd).toBe('');
    }
  });

  test('only one standalone literal forge merge can consume a passing record', () => {
    record(passing);
    const nextHead = 'b'.repeat(40);
    for (const cmd of [
      'glab mr merge 12 --yes; glab mr merge 999 --yes',
      `git push origin ${nextHead}:refs/heads/feat/thing && glab mr merge 12 --yes`,
      'bash -c "glab mr merge 12 --yes"',
      'glab mr merge 12 --yes\nglab mr merge 999 --yes',
      'glab mr merge 12 --repo "$(git push origin HEAD:feat/thing && echo owner/repo)"',
      'gh pr merge 12 $MERGE_ARGS',
      'gh pr merge 12 --repo owner/reviewed --repo owner/unreviewed',
      '/usr/local/bin/gh pr merge 12 --squash',
      'glab mr accept 12 --yes',
    ]) {
      const out = runHook(cmd);
      expect(out, cmd).toContain('"deny"');
      expect(out, cmd).toContain('standalone forge CLI command');
    }
  });

  test('a path-qualified forge CLI does not evade merge detection', () => {
    record(passing);
    expect(runHook('/usr/local/bin/glab mr merge 999 --yes')).toContain('"deny"');
    expect(runHook('/usr/local/bin/gh pr merge 999 --squash')).toContain('"deny"');
  });

  test('a numeric flag value cannot be mistaken for the change id', () => {
    record({ head_sha: 'b'.repeat(40), verdict: 'pass', findings: [] }, 'other__branch');
    const out = runHook('gh pr merge --body 999 12 --squash');
    expect(out).toContain('"deny"');
    expect(out).toContain('standalone forge CLI command');
  });

  test('URL shapes that vary the path do not evade', () => {
    record(passing);
    // Each of these reaches the same endpoint by a slightly different spelling.
    // A gate that matches only the tidiest form is a gate with a door in it.
    for (const cmd of [
      'curl -X PUT https://gitlab.com/api/v4/projects/1/merge_requests/999/merge/',
      'curl -X PUT "https://gitlab.com/api/v4/projects/1/merge_requests/999/merge?squash=true"',
      'curl -X PUT "https://gitlab.com/api/v4/projects/grp%2Fproj/merge_requests/999/merge"',
      'glab api --method PUT projects/1/merge_requests/999/merge',
      // Assembled at runtime, so no single token carries the whole path.
      'BASE=https://gitlab.com/api/v4/projects/1/merge_requests; curl -X PUT "$BASE/999/merge"',
    ]) {
      expect(runHook(cmd)).toContain('"deny"');
    }
  });

  test('ordinary work is not caught by the wider rule', () => {
    record(passing);
    // The trade was "reading a merge URL denies". It was NOT "anything near a
    // merge_requests endpoint denies" — creating or listing must still pass.
    for (const cmd of [
      'curl -X POST https://gitlab.com/api/v4/projects/1/merge_requests -d x',
      'curl https://gitlab.com/api/v4/projects/1/merge_requests?state=opened',
      'git commit -m "feat: add a thing"',
      'git push -u origin feat/thing',
      // Prose naming both halves. Dropping the caller requirement made the
      // split-variable arm fire on any text carrying `merge_requests` and
      // `/merge`, so describing this very rule in a commit message was refused.
      // The arm now needs an INTERPOLATION reaching /merge, which prose has not.
      'git commit -m "docs: describe the merge_requests API and its /merge endpoint"',
      'echo "see docs on merge_requests and /merge for details"',
    ]) {
      expect(runHook(cmd)).toBe('');
    }
  });

  test('a runtime-assembled merge URL is caught however it is assembled', () => {
    record(passing);
    // The split-variable arm exists for these. An earlier narrowing keyed on a
    // `$VAR` interpolation and let five of the six through: command
    // substitution, backticks, `printf -v`, a positional parameter and a string
    // built inside an interpreter all reach the endpoint with no `$name` before
    // /merge. Adjacency is the signal — an assembled path joins something to
    // /merge, English puts a space in front of it.
    const mrs = 'https://gitlab.com/api/v4/projects/1/merge_requests';
    for (const cmd of [
      `BASE=${mrs}; ID=999; curl -X PUT "$BASE/$ID/merge"`,
      `BASE=$(echo ${mrs}); curl -X PUT "$(printf %s "$BASE/999")/merge"`,
      `curl -X PUT "\`echo ${mrs}/999\`/merge"`,
      `A=(${mrs}); curl -X PUT "\${A[0]}/999/merge"`,
      `printf -v U "%s/999/merge" "${mrs}"; curl -X PUT "$U"`,
      `set -- ${mrs}; curl -X PUT "$1/999/merge"`,
      `python3 -c "b='${mrs}'; put(b+'/999/merge')"`,
    ]) {
      expect(runHook(cmd)).toContain('"deny"');
    }
  });

  test('a heredoc-fed interpreter is gated too', () => {
    record(passing);
    // The exact shape that got through: the URL lives inside a heredoc body,
    // and nothing on the command line looks like an HTTP client.
    const cmd = [
      "python3 - <<'PY'",
      'import urllib.request',
      'urllib.request.urlopen("https://gitlab.com/api/v4/projects/1/merge_requests/999/merge")',
      'PY',
    ].join('\n');
    expect(runHook(cmd)).toContain('"deny"');
  });

  test('creating an MR over REST is not a merge', () => {
    record(passing);
    expect(runHook('curl -X POST https://gitlab.com/api/v4/projects/1/merge_requests -d x')).toBe('');
  });

  test('repository selectors after the literal change id remain bindable', () => {
    record(passing);
    expect(
      runHook(`glab mr merge 12 --repo group/proj --sha ${HEAD} --auto-merge=false`),
    ).toBe('');
    expect(runHook(`gh pr merge 12 --repo owner/repo --match-head-commit ${HEAD}`)).toBe('');
  });

  test('H1: -R / --repo flag variants are still gated', () => {
    record(passing);
    for (const cmd of [
      'glab -R group/proj mr merge 999',
      'gh -R o/r pr merge 999',
      'glab mr --repo group/proj merge 999',
    ]) {
      expect(runHook(cmd)).toContain('"deny"');
    }
  });

  test('H2: merging from another directory cannot borrow this repo record', () => {
    record(passing);
    // `cd /tmp && glab mr merge 12` used to ALLOW: the old hook read the local
    // branch, found none, and exited 0. Now the record is looked up in the
    // command's own directory, so it denies — whether because the target can't
    // be resolved or because that directory holds no record for it.
    expect(runHook('cd /tmp && glab mr merge 12', { cwd: '/tmp' })).toContain('"deny"');
  });

  test('H2b: a merge with no MR id is not a canonical command, so it is denied', () => {
    record(passing);
    expect(runHook('glab mr merge')).toContain('standalone forge CLI command');
  });

  test('M2: auto-merge is refused — it lands a head no review has seen', () => {
    record(passing);
    expect(runHook('glab mr merge 12 --auto')).toContain('auto-merge');
    expect(runHook('glab mr merge 12 --auto-merge')).toContain('auto-merge');
    for (const flag of ['--auto=true', '--auto=TRUE', '--auto=1']) {
      expect(runHook(`gh pr merge 12 ${flag} --match-head-commit ${HEAD}`)).toContain(
        'auto-merge',
      );
    }
  });

  test('REST merges are gated, contiguous or split across variables', () => {
    record(passing);
    expect(runHook('curl -X PUT https://gitlab.com/api/v4/projects/1/merge_requests/999/merge'))
      .toContain('"deny"');
    expect(runHook('gh api --method PUT /repos/o/r/pulls/999/merge')).toContain('"deny"');
    expect(
      runHook(
        'base=https://api.github.com/repos/o/r/pulls/12; action=merge; curl -X PUT "$base/$action"',
      ),
    ).toContain('"deny"');
  });

  test('a shell-wrapped merge is still a merge, in every calling convention', () => {
    record(passing);
    // Tokenising treats quoted text as data — correct, EXCEPT when a shell is
    // handed it to execute. These collapsed to one inert token and failed open.
    // The first attempt at this recognised only `<bare shell> -c <script>`, and
    // every form below EXCEPT that one still evaded it. Enumerating shell
    // calling conventions is a losing game, which is why the rule is now
    // "a shell is mentioned ⇒ expand every token".
    for (const cmd of [
      'bash -c "glab mr merge 999"',
      "sh -c 'gh pr merge 999 --squash'",
      'eval "glab mr merge 999"',
      'bash -lc "glab mr merge 999"', // combined flags
      '/bin/bash -c "glab mr merge 999"', // path-qualified interpreter
      'bash -e -u -c "glab mr merge 999"', // extra leading flags
      'sh -euc "gh pr merge 999"',
      'bash -c -- "glab mr merge 999"', // -- separator before the script
      'bash <<< "glab mr merge 999"', // here-string, no -c at all
      'echo "glab mr merge 999" | bash', // piped into a shell
      'env bash -c "glab mr merge 999"',
      'timeout 5 bash -c "glab mr merge 999"',
    ]) {
      expect(runHook(cmd), cmd).toContain('"deny"');
    }
  });

  test('nesting deeper than the expansion bound does not become a hole', () => {
    record(passing);
    // The bound existed to stop runaway recursion, but returning the level's
    // tokens unexpanded at the cap made nest-5 ALLOW. Exhausting the bound now
    // falls back to whitespace splitting, which over-matches.
    let cmd = 'glab mr merge 999';
    for (let i = 0; i < 8; i++) {
      cmd = `bash -c ${JSON.stringify(cmd)}`;
      expect(runHook(cmd), `nest ${i + 1}`).toContain('"deny"');
    }
  });

  test('a shell-wrapped merge is caught even without python3', () => {
    record(passing);
    // The tokeniser needs python3; without it the hook splits on whitespace.
    // That left quotes glued to the first word (`"glab`), so exact-token
    // matching missed and the merge was ALLOWED — a fail-open on a machine
    // that merely lacks python3.
    const stub = join(bin, '..', 'stub');
    mkdirSync(stub, { recursive: true });
    const p = join(stub, 'python3');
    writeFileSync(p, '#!/bin/sh\nexit 127\n');
    chmodSync(p, 0o755);
    const res = spawnSync('bash', [HOOK], {
      cwd: repo,
      input: JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'bash -c "glab mr merge 999"' },
        session_id: 'test-session',
      }),
      encoding: 'utf-8',
      env: { ...process.env, PATH: `${stub}:${bin}:${process.env.PATH}`, HOME: home },
    });
    expect(res.stdout ?? '').toContain('"deny"');
  });

  test('every push option is scanned, not just the first', () => {
    record(passing);
    // The idiomatic GitLab form passes several -o flags. Reading only the
    // token after the FIRST one let the merge option through.
    for (const cmd of [
      'git push -o ci.skip -o merge_request.merge_when_pipeline_succeeds origin b',
      'git push -o merge_request.target_branch=main -o merge_request.merge_when_pipeline_succeeds origin b',
      'git push --push-option merge_request.merge_when_pipeline_succeeds origin b',
      'git push -o "merge_request.merge_when_pipeline_succeeds" origin b',
      "git push -o 'merge_request.merge_when_pipeline_succeeds' origin b",
      'git push --push-option="merge_request.merge_when_pipeline_succeeds" origin b',
    ]) {
      expect(runHook(cmd), cmd).toContain('"deny"');
    }
  });

  test('the literal change id precedes merge flags', () => {
    record(passing);
    expect(runHook(`gh pr merge 12 --squash --match-head-commit ${HEAD}`)).toBe('');
    expect(runHook(`glab mr merge 12 --yes --sha ${HEAD} --auto-merge=false`)).toBe('');
    expect(runHook('gh pr merge --squash 12')).toContain('standalone forge CLI command');
    expect(runHook('glab mr merge --yes 12')).toContain('standalone forge CLI command');
    expect(runHook('gh pr merge --squash 999')).toContain('"deny"');
    expect(runHook('glab mr merge --yes 999')).toContain('"deny"');
  });

  test('QUOTING a merge URL does not evade the gate', () => {
    record(passing);
    // The regression that made quote-STRIPPING the wrong fix: URLs are quoted
    // in every idiomatic REST call, so blanking quoted spans turned these from
    // gated into allowed — a fail-OPEN, the one direction a gate must not fail.
    for (const cmd of [
      'curl -X PUT "https://gitlab.com/api/v4/projects/1/merge_requests/999/merge"',
      "curl -X PUT 'https://gitlab.com/api/v4/projects/1/merge_requests/999/merge'",
      'gh api --method PUT "/repos/o/r/pulls/999/merge"',
    ]) {
      expect(runHook(cmd), cmd).toContain('"deny"');
    }
  });

  test('quoting a CLI merge does not evade the gate either', () => {
    record(passing);
    expect(runHook('glab mr merge "999" --squash --yes')).toContain('"deny"');
    expect(runHook('glab mr merge 999 --repo "group/proj"')).toContain('"deny"');
  });

  test('an unparseable command line still gates the merge', () => {
    record(passing);
    // Unbalanced quotes cannot be tokenised; the fallback splits on whitespace,
    // which over-matches. A merge must never slip through because the line
    // failed to parse.
    expect(runHook('glab mr merge 999 --squash "oops')).toContain('"deny"');
  });
});

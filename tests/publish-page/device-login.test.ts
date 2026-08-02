import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOrAuthorize } from '../../skills/publish-page/auth.ts';
import { shouldCommitCanonical } from '../../skills/publish-page/publish-policy.ts';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true });
});

describe('publish-page device login', () => {
  test('the publisher sends its computed title to the account dashboard', async () => {
    const source = await readFile(
      new URL('../../skills/publish-page/publish.ts', import.meta.url),
      'utf8',
    );
    expect(source).toContain("'x-page-title': encodeURIComponent(title)");
  });

  test('canonical git archival is explicit for private pages', () => {
    expect(shouldCommitCanonical([])).toBe(false);
    expect(shouldCommitCanonical(['--git'])).toBe(true);
    expect(shouldCommitCanonical(['--git', '--no-git'])).toBe(false);
  });

  test('an existing device token is reused without a network request', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agentkit-pages-auth-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'pages-token');
    await Bun.write(path, 'existing-token\n');

    const token = await loadOrAuthorize({
      endpoint: 'https://account.agentkit.sbs',
      tokenPath: path,
      fetcher: async () => { throw new Error('network must not be called'); },
    });

    expect(token).toBe('existing-token');
  });

  test('a missing token runs device authorization and stores the credential with mode 0600', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agentkit-pages-auth-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'config', 'pages-token');
    const messages: string[] = [];
    const opened: string[] = [];
    const responses = [
      Response.json({
        device_code: 'device-code',
        user_code: 'ABCD-2345',
        verification_uri_complete: 'https://account.agentkit.sbs/device?user_code=ABCD-2345',
        expires_in: 600,
        interval: 5,
      }),
      Response.json({ error: 'authorization_pending' }, { status: 400 }),
      Response.json({ access_token: 'new-device-token', token_type: 'Bearer' }),
    ];

    const token = await loadOrAuthorize({
      endpoint: 'https://account.agentkit.sbs',
      tokenPath: path,
      deviceName: 'Test Mac',
      fetcher: async () => responses.shift()!,
      sleep: async () => {},
      open: (url) => opened.push(url),
      output: (message) => messages.push(message),
    });

    expect(token).toBe('new-device-token');
    expect(opened).toEqual(['https://account.agentkit.sbs/device?user_code=ABCD-2345']);
    expect(messages.join('\n')).toContain('ABCD-2345');
    expect(await readFile(path, 'utf8')).toBe('new-device-token\n');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
});

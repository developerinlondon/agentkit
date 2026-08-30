import { afterEach, describe, expect, test } from 'bun:test';
import worker from '../../pages/worker/src/worker.js';
import {
  ACCOUNT_URL,
  accountEnv,
  digest,
  openDatabases,
  pageAccessUrl,
  PAGES_URL,
  publish,
  signedIn,
} from './account-harness.ts';

afterEach(() => {
  for (const database of openDatabases.splice(0)) database.close();
});

async function ownerLocation(setup: Awaited<ReturnType<typeof accountEnv>>) {
  const { location } = await pageAccessUrl(setup);
  return new URL(location!);
}

function shareAction(manage: string, action: string, slug = 'private-page') {
  return new Request(`${PAGES_URL}/api/pages/${slug}/share`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${manage}`,
      'content-type': 'application/json',
      origin: PAGES_URL,
    },
    body: JSON.stringify({ action }),
  });
}

async function enabledShareUrl(setup: Awaited<ReturnType<typeof accountEnv>>) {
  const manage = (await ownerLocation(setup)).searchParams.get('manage')!;
  const response = await worker.fetch(shareAction(manage, 'enable'), setup.env);
  const { url } = await response.json() as { url: string };
  return { manage, url };
}

async function seedLegacyShare(setup: Awaited<ReturnType<typeof accountEnv>>) {
  setup.database.sqlite.run(
    'UPDATE pages SET share_token_hash = ?, share_enabled = 0 WHERE slug = ?',
    [await digest('legacy-token'), 'private-page'],
  );
}

describe('derivable share links', () => {
  test('required mode fails closed and loud without the share key', async () => {
    const setup = await accountEnv();
    delete (setup.env as Record<string, unknown>).SHARE_LINK_KEY;
    const response = await worker.fetch(new Request(`${PAGES_URL}/private-page`), setup.env);
    expect(response.status).toBe(503);
    expect(await response.text()).toContain('share key unconfigured');
  });

  test('off then on mints a fresh link instead of resurrecting the revoked one', async () => {
    const setup = await accountEnv();
    expect((await worker.fetch(publish('device-a'), setup.env)).status).toBe(200);
    const { manage, url } = await enabledShareUrl(setup);

    await worker.fetch(shareAction(manage, 'off'), setup.env);
    const back = await (await worker.fetch(shareAction(manage, 'enable'), setup.env)).json() as { url: string };
    expect(back.url).not.toBe(url);
    expect((await worker.fetch(new Request(url), setup.env)).status).toBe(302);
    expect((await worker.fetch(new Request(back.url), setup.env)).status).toBe(200);
  });

  test('a legacy link keeps working and enable refuses to rotate it', async () => {
    const setup = await accountEnv();
    expect((await worker.fetch(publish('device-a'), setup.env)).status).toBe(200);
    await seedLegacyShare(setup);
    const legacyUrl = `${PAGES_URL}/private-page?share=legacy-token`;
    expect((await worker.fetch(new Request(legacyUrl), setup.env)).status).toBe(200);

    const manage = (await ownerLocation(setup)).searchParams.get('manage')!;
    const kept = await (await worker.fetch(shareAction(manage, 'enable'), setup.env)).json() as {
      already: boolean;
      legacy: boolean;
      url: string | null;
    };
    expect(kept).toMatchObject({ already: true, legacy: true, url: null });
    expect((await worker.fetch(new Request(legacyUrl), setup.env)).status).toBe(200);

    const rotated = await (await worker.fetch(shareAction(manage, 'rotate'), setup.env)).json() as { url: string };
    expect((await worker.fetch(new Request(legacyUrl), setup.env)).status).toBe(302);
    expect((await worker.fetch(new Request(rotated.url), setup.env)).status).toBe(200);
    expect(setup.database.sqlite.query('SELECT share_token_hash FROM pages WHERE slug = ?').get('private-page'))
      .toEqual({ share_token_hash: null });
  });

  test('an unknown share action is refused, never treated as rotate', async () => {
    const setup = await accountEnv();
    expect((await worker.fetch(publish('device-a'), setup.env)).status).toBe(200);
    const { manage, url } = await enabledShareUrl(setup);
    expect((await worker.fetch(shareAction(manage, 'disable'), setup.env)).status).toBe(400);
    expect((await worker.fetch(new Request(url), setup.env)).status).toBe(200);
  });

  test('share reads are marked uncacheable so revocation is not outlived', async () => {
    const setup = await accountEnv();
    expect((await worker.fetch(publish('device-a'), setup.env)).status).toBe(200);
    const { url } = await enabledShareUrl(setup);
    const read = await worker.fetch(new Request(url), setup.env);
    expect(read.headers.get('cache-control')).toBe('private, no-store');
  });

  test('an access grant outranks a share token so the owner reaches the shell', async () => {
    const setup = await accountEnv();
    expect((await worker.fetch(publish('device-a'), setup.env)).status).toBe(200);
    const { url } = await enabledShareUrl(setup);
    const owner = await ownerLocation(setup);
    owner.searchParams.set('share', new URL(url).searchParams.get('share')!);
    const response = await worker.fetch(new Request(owner.toString()), setup.env);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('<iframe id="content"');
  });
});

describe('owner-hint upgrade of share-link visits', () => {
  test('the shell records its slug in the hint cookie', async () => {
    const setup = await accountEnv();
    expect((await worker.fetch(publish('device-a'), setup.env)).status).toBe(200);
    const shell = await worker.fetch(new Request((await ownerLocation(setup)).toString()), setup.env);
    const hint = shell.headers.get('set-cookie') ?? '';
    expect(hint).toContain('agentkit_owner=private-page');
    expect(hint).toContain('HttpOnly');
  });

  test('a hinted browser is bounced through /access and back into the shell', async () => {
    const setup = await accountEnv();
    expect((await worker.fetch(publish('device-a'), setup.env)).status).toBe(200);
    const { url } = await enabledShareUrl(setup);
    const token = new URL(url).searchParams.get('share')!;

    const bounced = await worker.fetch(
      new Request(url, { headers: { cookie: 'agentkit_owner=private-page' } }),
      setup.env,
    );
    expect(bounced.status).toBe(302);
    const access = new URL(bounced.headers.get('location')!);
    expect(access.origin + access.pathname).toBe(`${ACCOUNT_URL}/access`);
    expect(new URL(access.searchParams.get('return_to')!).searchParams.get('share')).toBe(token);

    const upgraded = await worker.fetch(signedIn(access.toString()), setup.env);
    expect(upgraded.status).toBe(302);
    const landing = new URL(upgraded.headers.get('location')!);
    expect(landing.searchParams.get('share')).toBeNull();
    expect(landing.searchParams.get('access')).toBeTruthy();
    expect(landing.searchParams.get('manage')).toBeTruthy();
  });

  test('plain=1 stops the bounce; a foreign slug hint never starts one', async () => {
    const setup = await accountEnv();
    expect((await worker.fetch(publish('device-a'), setup.env)).status).toBe(200);
    const { url } = await enabledShareUrl(setup);

    const plain = await worker.fetch(
      new Request(`${url}&plain=1`, { headers: { cookie: 'agentkit_owner=private-page' } }),
      setup.env,
    );
    expect(plain.status).toBe(200);

    const foreign = await worker.fetch(
      new Request(url, { headers: { cookie: 'agentkit_owner=some-other-page' } }),
      setup.env,
    );
    expect(foreign.status).toBe(200);
  });

  test('a signed-out hinted browser lands back on the plain page, not a login wall', async () => {
    const setup = await accountEnv();
    expect((await worker.fetch(publish('device-a'), setup.env)).status).toBe(200);
    const { url } = await enabledShareUrl(setup);
    const bounced = await worker.fetch(
      new Request(url, { headers: { cookie: 'agentkit_owner=private-page' } }),
      setup.env,
    );
    const denied = await worker.fetch(new Request(bounced.headers.get('location')!), setup.env);
    expect(denied.status).toBe(302);
    const back = new URL(denied.headers.get('location')!);
    expect(back.searchParams.get('plain')).toBe('1');
    expect((await worker.fetch(new Request(back.toString()), setup.env)).status).toBe(200);
  });

  test('a keyless dashboard shows sharing as unavailable without a destructive toggle', async () => {
    const setup = await accountEnv();
    expect((await worker.fetch(publish('device-a'), setup.env)).status).toBe(200);
    const { url } = await enabledShareUrl(setup);
    expect(url).toBeTruthy();
    (setup.env as Record<string, unknown>).ACCOUNT_MODE = 'optional';
    delete (setup.env as Record<string, unknown>).SHARE_LINK_KEY;
    const body = await (await worker.fetch(signedIn(`${ACCOUNT_URL}/dashboard`), setup.env)).text();
    expect(body).toContain('Sharing unavailable');
    expect(body).not.toContain('made before links were shown here');
    expect(body).not.toContain('name="enabled" value="false"');
  });
});

describe('bare share URLs for generated slugs', () => {
  const GENERATED = 'abc123abc123abc123ab';

  test('sharing on makes the bare page URL itself serve to anyone', async () => {
    const setup = await accountEnv();
    expect((await worker.fetch(publish('device-a', '<h1>bare</h1>', GENERATED), setup.env)).status).toBe(200);
    expect((await worker.fetch(new Request(`${PAGES_URL}/${GENERATED}`), setup.env)).status).toBe(302);

    const manage = new URL((await pageAccessUrl(setup, GENERATED)).location!).searchParams.get('manage')!;
    const on = await (await worker.fetch(shareAction(manage, 'enable', GENERATED), setup.env)).json() as { url: string };
    expect(on.url).toBe(`${PAGES_URL}/${GENERATED}`);

    const read = await worker.fetch(new Request(`${PAGES_URL}/${GENERATED}`), setup.env);
    expect(read.status).toBe(200);
    expect(await read.text()).toBe('<h1>bare</h1>');

    await worker.fetch(shareAction(manage, 'off', GENERATED), setup.env);
    expect((await worker.fetch(new Request(`${PAGES_URL}/${GENERATED}`), setup.env)).status).toBe(302);
  });

  test('a readable custom slug keeps requiring the share token when shared', async () => {
    const setup = await accountEnv();
    expect((await worker.fetch(publish('device-a'), setup.env)).status).toBe(200);
    const { url } = await enabledShareUrl(setup);
    expect(url).toContain('?share=');
    expect((await worker.fetch(new Request(`${PAGES_URL}/private-page`), setup.env)).status).toBe(302);
    expect((await worker.fetch(new Request(url), setup.env)).status).toBe(200);
  });

  test('a hinted owner browser on the bare URL is upgraded to the shell', async () => {
    const setup = await accountEnv();
    expect((await worker.fetch(publish('device-a', '<h1>bare</h1>', GENERATED), setup.env)).status).toBe(200);
    const manage = new URL((await pageAccessUrl(setup, GENERATED)).location!).searchParams.get('manage')!;
    await worker.fetch(shareAction(manage, 'enable', GENERATED), setup.env);

    const bounced = await worker.fetch(
      new Request(`${PAGES_URL}/${GENERATED}`, { headers: { cookie: `agentkit_owner=${GENERATED}` } }),
      setup.env,
    );
    expect(bounced.status).toBe(302);
    const upgraded = await worker.fetch(signedIn(bounced.headers.get('location')!), setup.env);
    expect(upgraded.status).toBe(302);
    expect(new URL(upgraded.headers.get('location')!).searchParams.get('manage')).toBeTruthy();
  });

  test('a hinted but signed-out browser falls back to the plain page, not login', async () => {
    const setup = await accountEnv();
    expect((await worker.fetch(publish('device-a', '<h1>bare</h1>', GENERATED), setup.env)).status).toBe(200);
    const manage = new URL((await pageAccessUrl(setup, GENERATED)).location!).searchParams.get('manage')!;
    await worker.fetch(shareAction(manage, 'enable', GENERATED), setup.env);

    const bounced = await worker.fetch(
      new Request(`${PAGES_URL}/${GENERATED}`, { headers: { cookie: `agentkit_owner=${GENERATED}` } }),
      setup.env,
    );
    const back = await worker.fetch(new Request(bounced.headers.get('location')!), setup.env);
    expect(back.status).toBe(302);
    const landing = new URL(back.headers.get('location')!);
    expect(landing.searchParams.get('plain')).toBe('1');
    expect((await worker.fetch(new Request(landing.toString()), setup.env)).status).toBe(200);
  });

  test('a legacy-shared generated slug serves bare and shows its bare link', async () => {
    const setup = await accountEnv();
    expect((await worker.fetch(publish('device-a', '<h1>bare</h1>', GENERATED), setup.env)).status).toBe(200);
    setup.database.sqlite.run(
      'UPDATE pages SET share_token_hash = ?, share_enabled = 0 WHERE slug = ?',
      [await digest('legacy-token'), GENERATED],
    );
    expect((await worker.fetch(new Request(`${PAGES_URL}/${GENERATED}`), setup.env)).status).toBe(200);
    expect((await worker.fetch(new Request(`${PAGES_URL}/${GENERATED}?share=legacy-token`), setup.env)).status).toBe(200);

    const manage = new URL((await pageAccessUrl(setup, GENERATED)).location!).searchParams.get('manage')!;
    const kept = await (await worker.fetch(shareAction(manage, 'enable', GENERATED), setup.env)).json() as {
      url: string | null;
      legacy?: boolean;
    };
    expect(kept.url).toBe(`${PAGES_URL}/${GENERATED}`);
    expect(kept.legacy).toBeFalsy();
  });

  test('a signed-in stranger heading for a bare-shared page lands on it, not a 403', async () => {
    const setup = await accountEnv();
    expect((await worker.fetch(publish('device-a', '<h1>bare</h1>', GENERATED), setup.env)).status).toBe(200);
    const manage = new URL((await pageAccessUrl(setup, GENERATED)).location!).searchParams.get('manage')!;
    await worker.fetch(shareAction(manage, 'enable', GENERATED), setup.env);

    const target = `${ACCOUNT_URL}/access?return_to=${encodeURIComponent(`${PAGES_URL}/${GENERATED}`)}`;
    const bounced = await worker.fetch(signedIn(target, 'session-b'), setup.env);
    expect(bounced.status).toBe(302);
    const landing = new URL(bounced.headers.get('location')!);
    expect(landing.searchParams.get('plain')).toBe('1');
    expect((await worker.fetch(new Request(landing.toString()), setup.env)).status).toBe(200);
  });

  test('a private generated slug stays private', async () => {
    const setup = await accountEnv();
    expect((await worker.fetch(publish('device-a', '<h1>bare</h1>', GENERATED), setup.env)).status).toBe(200);
    expect((await worker.fetch(new Request(`${PAGES_URL}/${GENERATED}`), setup.env)).status).toBe(302);
    expect((await worker.fetch(new Request(`${PAGES_URL}/${GENERATED}?share=guess`), setup.env)).status).toBe(302);
  });
});

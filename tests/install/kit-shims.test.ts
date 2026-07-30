import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readSkillKits } from '../../scripts/skill-kits';

const repoRoot = join(import.meta.dir, '..', '..');
const manifest = readSkillKits(repoRoot);

// Each non-explicit opt-in kit gets a curl-able one-line installer under
// kits/<id>. Explicit kits stay off that path on purpose: their consent story
// is a literal, typed --with.
describe('per-kit install shims', () => {
  const optIn = manifest.kits.filter((kit) => kit.id !== 'core' && !kit.explicit);
  const explicit = manifest.kits.filter((kit) => kit.explicit);

  test('every non-explicit opt-in kit ships a shim that preselects it', () => {
    expect(optIn.length).toBeGreaterThan(0);
    for (const kit of optIn) {
      const shim = join(repoRoot, 'kits', kit.id);
      expect(existsSync(shim), shim).toBe(true);
      expect(statSync(shim).mode & 0o111, `${shim} must be executable`).not.toBe(0);
      const body = readFileSync(shim, 'utf8');
      expect(body).toContain('bootstrap.sh');
      expect(body).toContain(`--with ${kit.id}`);
      expect(body).toContain('"$@"');
    }
  });

  test('explicit kits have no shim', () => {
    for (const kit of explicit) {
      expect(existsSync(join(repoRoot, 'kits', kit.id)), kit.id).toBe(false);
    }
  });
});

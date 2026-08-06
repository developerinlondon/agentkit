import { join } from 'node:path';

// One tree, two origins: the repository's own tastes at the root of
// `.agentkit/tastes/`, and a snapshot of each declared source beneath
// `external/`. Two sibling directories would say there are two kinds of thing.
export const EXTERNAL_DIR = 'external';

// Where the snapshots lived before the move. Read for one release of grace so a
// clone that predates it still has its policy; the next sync relocates it.
export const LEGACY_EXTERNAL_ROOT = 'tastes-vendor';

export function tastesRoot(cwd: string): string {
  return join(cwd, '.agentkit', 'tastes');
}

export function externalRoot(cwd: string): string {
  return join(tastesRoot(cwd), EXTERNAL_DIR);
}

export function legacyExternalRoot(cwd: string): string {
  return join(cwd, '.agentkit', LEGACY_EXTERNAL_ROOT);
}

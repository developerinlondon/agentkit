import { join } from 'node:path';
import { lintTasteDirectory } from './lint.ts';

// Where a source was declared, which decides where its snapshot lands: a
// repository's own config vendors into that repository, the machine's config
// into the owner's home directory.
export type SourceScope = 'project' | 'user';

export const CONFIG_SCOPES: SourceScope[] = ['project', 'user'];

// The two units a `brain:` config declares sources for. They share every piece
// of machinery below — declaration, pinning, vendoring, the visibility guard —
// and share no store, because what is true and what to do resolve differently.
export type Unit = 'taste' | 'memory';

export interface Store {
  unit: Unit;
  key: string;
  noun: string;
  plural: string;
  emptyLabel: string;
  externalLabel: string;
  lockLabel: string;
  // Memory's repository vault sits at the top of the checkout and taste's under
  // .agentkit/, so the tree is a function of the scope rather than one path.
  tree(scope: SourceScope, root: string): string;
  lock(root: string): string;
  // Only taste had a home for snapshots before `external/` existed.
  legacy: boolean;
  check(dir: string): string[];
}

export const TASTE: Store = {
  unit: 'taste',
  key: 'brain.taste.sources',
  noun: 'taste',
  plural: 'tastes',
  emptyLabel: 'taste files',
  externalLabel: '.agentkit/tastes/external/',
  lockLabel: '.agentkit/tastes.lock',
  tree: (_scope, root) => join(root, '.agentkit', 'tastes'),
  lock: (root) => join(root, '.agentkit', 'tastes.lock'),
  legacy: true,
  check: lintTasteDirectory,
};

// A note carries no frontmatter contract, so there is nothing to lint: copying
// markdown and nothing else is the whole of what a memory source must satisfy,
// and one holding no markdown at all is refused by the caller.
export const MEMORY: Store = {
  unit: 'memory',
  key: 'brain.memory.sources',
  noun: 'note',
  plural: 'notes',
  emptyLabel: 'notes',
  externalLabel: 'memory/external/',
  lockLabel: '.agentkit/memory.lock',
  tree: (scope, root) =>
    scope === 'project' ? join(root, 'memory') : join(root, '.agentkit', 'memory'),
  lock: (root) => join(root, '.agentkit', 'memory.lock'),
  legacy: false,
  check: () => [],
};

export const STORES: Store[] = [TASTE, MEMORY];

export function storeFor(unit: string): Store | undefined {
  return STORES.find((store) => store.unit === unit);
}

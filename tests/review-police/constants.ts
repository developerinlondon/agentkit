import { join } from 'node:path';

export const TESTS_DIR = join(import.meta.dir, '..');
export const HOOK_DIR = join(TESTS_DIR, '..', 'hooks', 'claude');
export const HOOK = join(HOOK_DIR, 'review-police.sh');
export const SUPERVISOR = join(HOOK_DIR, 'fail-closed-hook.sh');

export const SOURCE_BRANCH = 'feat/thing';
export const HEAD = 'a'.repeat(40);
export const REPOSITORY = 'https://github.example/owner/repo';
export const REPOSITORY_ID = 'gitlab:github.example:1';

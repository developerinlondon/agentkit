#!/usr/bin/env bun
// The hosting ladder's floor: one HTML file that opens by double-click, with no
// server, no network and no build step — so a brief survives a private GitLab,
// an air-gapped laptop or an email attachment.

import { join } from 'node:path';
import { briefTitle, renderBrief } from './doc.ts';

const themeSkill = join(import.meta.dir, '..', '..', 'publish-page');

// Deferred so the markdown lane keeps working without the publish-page skill's
// dependencies, and so a missing install names its own fix.
async function themeRenderer() {
  try {
    return await import('../../publish-page/render-html.ts');
  } catch (error) {
    throw new Error(
      `page renderer unavailable (${(error as Error).message}) — run: cd ${themeSkill} && bun install`,
    );
  }
}

export async function renderBriefHtml(dir: string): Promise<string> {
  const { bundledThemePath, renderThemed } = await themeRenderer();
  return renderThemed({
    source: renderBrief(dir),
    isMd: false,
    template: 'doc',
    title: briefTitle(dir),
    // The bundled theme, never the agentkit-pages clone publish.ts prefers: a
    // portable page must render the same bytes where no clone exists.
    themePath: bundledThemePath('doc'),
  });
}

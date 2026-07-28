// Theme wrapping shared by the two ways a page leaves this repo: publish.ts
// PUTs it to the pages worker, and the product-intelligence --html lane writes
// it to a file that must open from file://. One implementation, so a portable
// page and a published page are the same page.
import { marked } from "marked";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string
  );
}

// Split markdown into slides on `---` lines, ignoring YAML frontmatter and
// `---` inside fenced code blocks — a naive regex split cuts fences in half.
export function splitSlides(md: string): string[] {
  let lines = md.split("\n");
  if (lines[0]?.trim() === "---") {
    const close = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
    if (close > 0) lines = lines.slice(close + 1);
  }
  const slides: string[][] = [[]];
  let fence: string | null = null;
  for (const line of lines) {
    const open = line.match(/^\s*(```|~~~)/)?.[1];
    if (open) fence = fence === open ? null : fence ?? open;
    if (!fence && line.trim() === "---") slides.push([]);
    else slides[slides.length - 1].push(line);
  }
  return slides.map((s) => s.join("\n"));
}

export function bundledThemePath(template: string): string {
  return join(import.meta.dir, "themes", `${template}.html`);
}

// Mermaid fences via marked's renderer, not a regex: fence-aware (nesting,
// splitSlides sees real fences) and escaped (mermaid decodes via textContent).
marked.use({
  renderer: {
    code({ text, lang }: { text: string; lang?: string }) {
      return lang === "mermaid" ? `<pre class="mermaid">${escapeHtml(text)}</pre>\n` : false;
    },
  },
});

export async function mermaidRuntime(): Promise<string> {
  const dist = join(import.meta.dir, "node_modules/mermaid/dist/mermaid.min.js");
  if (!existsSync(dist)) {
    throw new Error(`mermaid runtime missing at ${dist} — run: cd ${import.meta.dir} && bun install`);
  }
  const js = await readFile(dist, "utf8");
  // Decks render diagrams per-slide (hidden slides have zero width, which breaks
  // mermaid's measurements) — the deck theme's show() calls mermaid.run on the
  // active slide; docs render everything immediately.
  const init = `(() => {
  const DARK = { darkMode: true, background: "transparent", primaryColor: "#1b1d22", primaryBorderColor: "#3a4150", primaryTextColor: "#eeeeee", secondaryColor: "#16181c", tertiaryColor: "#152438", lineColor: "#6a7280", edgeLabelBackground: "#0a0a0c", nodeBorder: "#3a4150", mainBkg: "#1b1d22", clusterBkg: "#16181c", clusterBorder: "#2a2d34", fontFamily: "ui-monospace, Menlo, monospace", fontSize: "14px", actorBkg: "#1b1d22", actorBorder: "#3a4150", actorTextColor: "#eeeeee", signalColor: "#6a7280", signalTextColor: "#9aa0aa", noteBkgColor: "#152438", noteTextColor: "#eeeeee", noteBorderColor: "#2a2d34" };
  const LIGHT = { darkMode: false, background: "transparent", primaryColor: "#ffffff", primaryBorderColor: "#c3cbd6", primaryTextColor: "#1a1a1a", secondaryColor: "#f0f3f7", tertiaryColor: "#e3ecf8", lineColor: "#5f6672", edgeLabelBackground: "#eef0f4", nodeBorder: "#c3cbd6", mainBkg: "#ffffff", clusterBkg: "#f0f3f7", clusterBorder: "#d5dae2", fontFamily: "ui-monospace, Menlo, monospace", fontSize: "14px", actorBkg: "#ffffff", actorBorder: "#c3cbd6", actorTextColor: "#1a1a1a", signalColor: "#5f6672", signalTextColor: "#5f6672", noteBkgColor: "#e3ecf8", noteTextColor: "#1a1a1a", noteBorderColor: "#d5dae2" };
  const srcs = new Map();
  function renderAll() {
    const light = document.documentElement.dataset.theme === "light";
    mermaid.initialize({ startOnLoad: false, theme: "base", themeVariables: light ? LIGHT : DARK, flowchart: { curve: "basis", nodeSpacing: 46, rankSpacing: 56, padding: 12 } });
    document.querySelectorAll("pre.mermaid").forEach((el) => {
      if (!srcs.has(el)) srcs.set(el, el.textContent);
      el.removeAttribute("data-processed");
      el.replaceChildren();
      el.textContent = srcs.get(el);
    });
    if (document.querySelector(".slide")) mermaid.run({ querySelector: ".slide.active pre.mermaid" });
    else mermaid.run();
  }
  renderAll();
  addEventListener("agentkit-theme", renderAll);
})();`;
  return `\n<script>${js}</script>\n<script>${init}</script>`;
}

export interface ThemedPage {
  source: string;
  isMd: boolean;
  template: string;
  title: string;
  themePath: string;
}

export async function renderThemed(page: ThemedPage): Promise<string> {
  const theme = await readFile(page.themePath, "utf8");
  let content: string;
  if (page.template === "deck") {
    const parts = page.isMd
      ? splitSlides(page.source).map((s) => marked.parse(s) as string)
      : page.source.split(/<hr\b[^>]*>/i);
    content = parts
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => `<section class="slide">\n${s}\n</section>`)
      .join("\n");
  } else {
    content = page.isMd ? (marked.parse(page.source) as string) : page.source;
  }
  if (content.includes('class="mermaid"')) content += await mermaidRuntime();
  // Function replacers: a plain string replacement expands $&, $`, $' found in
  // page content and silently corrupts the output.
  return theme
    .replaceAll("{{TITLE}}", () => escapeHtml(page.title))
    .replaceAll("{{CONTENT}}", () => content);
}

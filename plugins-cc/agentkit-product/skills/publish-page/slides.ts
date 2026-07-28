// The one definition of what cuts a slide. render-html.ts splits pages on it
// and re-exports it, the brief renderer neutralises authored rules against it,
// and the suites assert against it — a second scanner that re-derives the rule
// drifts, and the drift is where an authored line mints a slide nobody wrote.
// It sits apart from render-html.ts only because that file imports marked, and
// a renderer neutralising against this scanner must not take on that weight.

// Fence markers belong to the block they open, so a `---` on the opening line
// of a fence is content, not a break.
export function outsideFences(lines: string[]): boolean[] {
  let fence: string | null = null;
  return lines.map((line) => {
    const marker = line.match(/^\s*(```|~~~)/)?.[1];
    if (marker) fence = fence === marker ? null : fence ?? marker;
    return !fence;
  });
}

// `line.trim() === "---"` and nothing narrower: trim() spans the whole Unicode
// whitespace set, so a hand-rolled character class here would pass an
// NBSP-prefixed rule that still cuts a slide downstream.
export function slideBreaks(lines: string[]): boolean[] {
  const open = outsideFences(lines);
  return lines.map((line, i) => open[i] && line.trim() === "---");
}

export function splitSlides(md: string): string[] {
  let lines = md.split("\n");
  if (lines[0]?.trim() === "---") {
    const close = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
    if (close > 0) lines = lines.slice(close + 1);
  }
  const breaks = slideBreaks(lines);
  const slides: string[][] = [[]];
  lines.forEach((line, i) => {
    if (breaks[i]) slides.push([]);
    else slides[slides.length - 1].push(line);
  });
  return slides.map((s) => s.join("\n"));
}

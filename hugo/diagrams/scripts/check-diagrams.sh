#!/bin/sh
# Run from a Hugo site that imports the diagrams module (or pass its path):
# builds it and fails if Mermaid is back, a spec is invalid or unused, a
# layout warning fired, or a figure holds a nested <svg>.
set -eu
cd "${1:-.}"
out=$(mktemp -d)
log="$out.log"
trap 'rm -rf "$out" "$log"' EXIT

fail=0
if grep -rln '```mermaid' content; then
  echo "FAIL: a mermaid code block is back in content/ (write data/diagrams/<name>.yaml instead)"
  fail=1
fi

if ! hugo --gc --minify -d "$out" >"$log" 2>&1; then
  cat "$log"
  echo "FAIL: hugo build (spec validation runs inside it)"
  exit 1
fi

if grep -E 'WARN.*diagram' "$log"; then
  echo "FAIL: diagram layout warnings above"
  fail=1
fi

if find "$out" -iname '*mermaid*' | grep .; then
  echo "FAIL: a mermaid file is published"
  fail=1
fi
if find "$out" \( -name '*.html' -o -name '*.js' \) -exec grep -li 'mermaid' {} + | grep .; then
  echo "FAIL: published HTML or JS mentions mermaid"
  fail=1
fi

# The minifier must not see a second <svg> inside a figure: it ends the figure
# there and the labels after it stop rendering.
nested=$(find "$out" -name '*.html' -exec node -e '
  const fs = require("fs"); let bad = [];
  for (const f of process.argv.slice(1)) {
    for (const m of fs.readFileSync(f, "utf8").matchAll(/<figure class="?dg[\s\S]*?<\/figure>/g)) {
      if ((m[0].match(/<svg/g) || []).length !== 1) bad.push(f);
    }
  }
  console.log([...new Set(bad)].join(" "));' {} +)
if [ -n "$nested" ]; then
  echo "FAIL: a figure contains more than one <svg>: $nested"
  fail=1
fi

specs=$(find data/diagrams -name '*.yaml' | wc -l)
json() { node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); console.log(eval(process.argv[2]))' "$out/architecture.json" "$1"; }
listed=$(json 'd.diagrams.length')
if [ "$specs" -ne "$listed" ]; then
  echo "FAIL: $specs specs in data/diagrams but $listed in architecture.json"
  fail=1
fi
unused=$(json 'd.diagrams.filter(x => !x.pages.length).map(x => x.name).join(" ")')
if [ -n "$unused" ]; then
  echo "FAIL: specs no page uses: $unused"
  fail=1
fi
if [ -f "$out/llms.txt" ] && ! grep -q 'architecture.json' "$out/llms.txt"; then
  echo "FAIL: llms.txt is published but does not point at architecture.json"
  fail=1
fi

[ "$fail" -eq 0 ] && echo "ok: $specs diagrams, no mermaid"
exit "$fail"

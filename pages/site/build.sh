#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

# Composes src/pages/*.html into the served tree under site/. Sharing happens
# at build time because the serving CSP is `default-src 'none'`: a page cannot
# link a stylesheet, script, font or image, so every asset must be inlined.
# Layout, page-source format and naming rules are documented in README.md.

SRC=src
OUT=site
LAYOUT="$SRC/layout.html"
KIT_ENV="$SRC/data/kit.env"

# Replaces a placeholder with the contents of a file, keeping whatever else
# shares the line. Anything on that line would otherwise vanish silently.
inject() {
	awk -v ph="$1" -v f="$2" '
		{
			i = index($0, ph)
			if (i == 0) { print; next }
			pre = substr($0, 1, i - 1)
			post = substr($0, i + length(ph))
			first = 1
			while ((getline line < f) > 0) {
				if (first) { print pre line; first = 0 } else { print line }
			}
			close(f)
			if (first) print pre post
			else if (post != "") print post
		}
	'
}

# By index rather than gsub, so & and \ in a title stay literal.
subst() {
	awk -v ph="$1" -v val="$2" '
		{
			i = index($0, ph)
			while (i > 0) {
				$0 = substr($0, 1, i - 1) val substr($0, i + length(ph))
				i = index($0, ph)
			}
			print
		}
	'
}

meta() { # meta <key> <file>
	awk -v k="@$1:" '
		index($0, k) {
			i = index($0, k) + length(k)
			s = substr($0, i)
			sub(/-->[[:space:]]*$/, "", s)
			gsub(/^[[:space:]]+|[[:space:]]+$/, "", s)
			print s
			exit
		}
	' "$2"
}

# Only the leading metadata block is build input. A `<!--@…-->` line further
# down belongs to the author, most likely a page documenting this format.
strip_meta() {
	awk 'head && /^[[:space:]]*<!--@/ { next }
	     head && /^[[:space:]]*$/ { next }
	     { head = 0; print }' head=1 "$1"
}

fail() { echo "build: $*" >&2; exit 1; }

[[ -s "$KIT_ENV" ]] || fail "$KIT_ENV is missing or empty — run pages/site/sync-kit-facts.sh"
# shellcheck source=/dev/null
. "$KIT_ENV"

# Derived from the ref being built, never committed — a committed copy went
# five releases stale while claiming to be current.
KIT_VERSION="${AGENTKIT_SITE_VERSION:-$(git describe --tags --abbrev=0 2>/dev/null || true)}"
[[ -n "$KIT_VERSION" ]] || fail "cannot resolve the kit version: set AGENTKIT_SITE_VERSION or fetch tags"
case "$KIT_VERSION" in v[0-9]*) ;; *) fail "kit version does not look like a release tag: '$KIT_VERSION'" ;; esac

# Identifies the commit the served bytes were built from. The commit date, not
# the wall clock, so rebuilding a commit reproduces its output byte for byte —
# the portability and mutation checks compare builds against each other.
if [[ -n "${CI_COMMIT_SHORT_SHA:-}" ]]; then
	BUILD_SHA="$CI_COMMIT_SHORT_SHA"
	BUILD_DATE="${CI_COMMIT_TIMESTAMP:0:10}"
elif BUILD_SHA=$(git rev-parse --short HEAD 2>/dev/null); then
	BUILD_DATE=$(git log -1 --format=%cs 2>/dev/null || true)
	# Uncommitted build inputs mean the bytes are not that commit's.
	[[ -z "$(git status --porcelain -- "$SRC" build.sh 2>/dev/null)" ]] || BUILD_SHA="$BUILD_SHA-dirty"
else
	fail "cannot identify the build: no CI_COMMIT_SHORT_SHA and no git metadata"
fi
case "${BUILD_SHA%-dirty}" in '' | *[!0-9a-f]*) fail "build sha is not a hex sha: '$BUILD_SHA'" ;; esac
case "$BUILD_DATE" in
[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) ;;
*) fail "build date is not YYYY-MM-DD: '$BUILD_DATE'" ;;
esac

# The CSP is `default-src 'none'` with only inline style/script and data: URIs,
# so anything fetched over a scheme is refused at runtime. Match the scheme
# rather than the tag; navigation hrefs on <a> are the one legitimate case.
check_no_external() {
	local f="$1" hit
	hit=$(grep -oE 'url\([^)]*\)' "$f" | grep -E 'https?:|//' || true)
	[[ -z "$hit" ]] || fail "$f: CSS url() fetches over the network: $hit"

	hit=$(grep -oE '@import[^;]*' "$f" || true)
	[[ -z "$hit" ]] || fail "$f: @import cannot load under the CSP: $hit"

	hit=$(grep -oE 'src=("[^"]*"|'\''[^'\'']*'\'')' "$f" | grep -vE '^src=.data:' || true)
	[[ -z "$hit" ]] || fail "$f: src must be a data: URI: $hit"

	hit=$(grep -oE 'srcset=' "$f" || true)
	[[ -z "$hit" ]] || fail "$f: srcset is not loadable under the CSP"

	hit=$(grep -oiE '<(link|iframe|object|embed)[ >]' "$f" || true)
	[[ -z "$hit" ]] || fail "$f: element cannot load its resource under the CSP: $hit"

	hit=$(grep -oE 'href=("[^"]*"|'\''[^'\'']*'\'')' "$f" \
		| grep -E 'https?:|//' \
		| grep -vE 'href=.https://(github\.com|raw\.githubusercontent\.com|agentkit\.sbs|pages\.agentkit\.sbs|account\.agentkit\.sbs)/' || true)
	[[ -z "$hit" ]] || fail "$f: unexpected off-site href: $hit"
}

rm -rf "$OUT"
mkdir -p "$OUT"

built=0
while IFS= read -r page; do
	rel=${page#"$SRC/pages/"}
	rel=${rel%.html}

	if [[ "$rel" == index ]]; then
		dest="$OUT/index.html"
	else
		# The worker rejects a path outside this shape. Caught here, the message
		# names the source file; caught at upload, it lands mid-walk with part of
		# the site already replaced.
		[[ "$rel" =~ ^[a-z0-9][a-z0-9-]{0,63}(/[a-z0-9][a-z0-9-]{0,63}){0,3}$ ]] \
			|| fail "$page maps to '$rel', which the Pages API will not accept as a path"
		dest="$OUT/$rel/index.html"
	fi
	mkdir -p "$(dirname "$dest")"

	id=$(meta id "$page")
	title=$(meta title "$page")
	description=$(meta description "$page")
	[[ -n "$title" ]] || fail "$page has no @title"
	[[ -n "$id" ]] || fail "$page has no @id"

	page_css="$SRC/pages/$rel.css"
	[[ -f "$page_css" ]] || page_css=/dev/null

	# Partials are injected before substitution so the shared header and footer
	# can carry placeholders too. Page content is still injected last, and so is
	# never scanned or substituted.
	shell=$(mktemp)
	inject '{{THEME}}' "$SRC/theme.css" < "$LAYOUT" \
		| inject '{{PAGE_CSS}}' "$page_css" \
		| inject '{{HEADER}}' "$SRC/header.html" \
		| inject '{{FOOTER}}' "$SRC/footer.html" \
		| inject '{{SHARED_JS}}' "$SRC/shared.js" \
		| subst '{{TITLE}}' "$title" \
		| subst '{{DESCRIPTION}}' "$description" \
		| subst '{{PAGE_ID}}' "$id" \
		| subst '{{BUILD_SHA}}' "$BUILD_SHA" \
		| subst '{{BUILD_DATE}}' "$BUILD_DATE" \
		> "$shell"

	if grep -v '{{CONTENT}}' "$shell" | grep -qE '\{\{[A-Z_]+\}\}'; then
		rm -f "$shell"
		fail "$LAYOUT still contains an unsubstituted placeholder"
	fi

	# Page content sees only the documented data tokens. Any other token is the
	# author reaching for a layout placeholder, so say so instead of silently
	# substituting it or silently leaving it in the served page.
	content=$(mktemp)
	strip_meta "$page" \
		| subst '{{KIT_VERSION}}' "$KIT_VERSION" \
		> "$content"

	stray=$(grep -oE '\{\{[A-Za-z_]+\}\}' "$content" | sort -u || true)
	if [[ -n "$stray" ]]; then
		rm -f "$shell" "$content"
		fail "$page uses token(s) that are not page data: $stray
  Data tokens are {{LEDGER_TOTAL}}, {{LEDGER_OBSERVED}}, {{LEDGER_INFERRED}},
  {{KIT_VERSION}}, {{KIT_SKILLS_TOTAL}}, {{KIT_SKILLS_CORE}}, {{KIT_SKILLS_PRODUCT}}, {{KIT_SKILLS_REVIEW}},
  {{KIT_UNITS_TOTAL}}, {{KIT_CORE_NAMES}}, {{KIT_PRODUCT_NAMES}}, {{KIT_REVIEW_NAMES}},
  {{UNITS_TABLE}}, {{RULES_TABLE}}, {{HOOKS_TABLE}}.
  To show a literal token in prose, write the braces as &#123;&#123;."
	fi

	inject '{{CONTENT}}' "$content" < "$shell" > "$dest"
	rm -f "$shell" "$content"

	check_no_external "$dest"

	echo "built: $dest ($(wc -c < "$dest") bytes)"
	built=$((built + 1))
done < <(find "$SRC/pages" -name '*.html' | sort)

echo "build: $built page(s)"

# The one place the stamped identity is written down, so deploy.sh compares the
# value that is actually in the pages rather than re-deriving it and drifting —
# CI's short sha is eight characters where git's is seven, and only one of those
# is in the HTML. Written last, so a failed build leaves no stale identity, and
# named so the upload walk (index.html only) cannot pick it up.
printf '%s\n' "$BUILD_SHA" > "$OUT/.build-sha"

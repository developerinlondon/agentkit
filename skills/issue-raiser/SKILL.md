---
name: issue-raiser
description: >-
  Raises well-structured GitLab issues with root cause analysis, proposed solutions,
  and correct assignees based on git history. Adapts to any GitLab instance and project
  conventions automatically. Triggers: raising issues, reporting bugs, creating tickets,
  filing defects, feature requests, refactoring proposals.
---

# Issue Raiser Skill

Create professional, well-researched GitLab issues that include root cause analysis,
concrete proposed solutions, and correctly identified assignees. This skill adapts to
whatever GitLab setup the current repository uses.

## Phase 0: Discover the Environment

Before doing anything, auto-detect the project's GitLab setup. Do NOT assume any
specific host, group, or project structure.

### Detect GitLab host and project path

```bash
# List all remotes — the user may have multiple (mirrors, forks, etc.)
git remote -v

# Determine the GitLab hostname from the remote URL
# SSH:   git@gitlab.example.com:group/project.git  → host=gitlab.example.com, path=group/project
# HTTPS: https://gitlab.example.com/group/project.git → same extraction
```

If multiple remotes exist, ask the user which one to target unless context makes it obvious.

### Determine if glab is configured for the target host

```bash
glab auth status
```

- If the target host appears in the auth status, use it directly.
- If it's a self-hosted instance not listed, every `glab` command needs `GITLAB_HOST=<detected-host>` prefixed.
- If auth is missing entirely, inform the user they need to run `glab auth login --hostname <host>`.

### Build your glab command prefix

Based on discovery, construct the prefix you'll use for all commands in this session:

```bash
# For gitlab.com (default host):
glab issue list -R <group/project>

# For self-hosted:
GITLAB_HOST=<detected-host> glab issue list -R <group/project>
```

Store this mentally and use it consistently. Never hardcode a host.

## Phase 1: Research Before Writing

### Understand the project's issue conventions

Every project has its own style. Discover it:

```bash
# List recent open issues to learn the format
<prefix> glab issue list -R <path> --per-page 10

# Read 2-3 issues to understand structure, tone, and depth
<prefix> glab issue view <recent-issue-number> -R <path>
```

Look for:
- Do issues use templates (Description / Acceptance Criteria / Technical Notes)?
- What level of detail is expected?
- Are code snippets included?
- What tone — formal, casual, terse?

### Discover available labels and milestones

```bash
# Labels
<prefix> glab label list -R <path>

# Milestones — try project-level first, then group-level
<prefix> glab api "projects/<url-encoded-path>/milestones?state=active"
<prefix> glab api "groups/<group>/milestones?state=active"
```

Choose labels and milestones that match the issue type. If unsure, match what similar
recent issues used.

### Check for duplicates

```bash
<prefix> glab issue list -R <path> --search "<keywords>"
```

If a related issue exists, reference it rather than duplicating.

### Verify the bug exists on latest code

Never file a bug based solely on deployed code — it may already be fixed:

```bash
# Fetch latest
git fetch <remote> --tags

# Check the relevant file on the latest default branch
git show <remote>/main:<path/to/file>

# Compare with what's deployed (look at image tags, helm values, etc.)
```

If the bug is fixed on latest but still deployed, note that in the issue.

## Phase 2: Build the Root Cause Analysis

This is what separates a useful issue from a vague bug report. Always include:

### Trace the code path

- Read the source files involved
- Identify the **exact** file, function, and line number where the problem originates
- Understand WHY the code behaves this way — don't just describe the symptom

### Trace the git history

```bash
# Who last modified the file?
git log <remote>/main --format='%an <%ae> | %s' -- <file> | head -10

# Who introduced the specific problematic code?
git log <remote>/main -S "<pattern>" --format='%h %an <%ae> | %s' -- <file>

# What does the blame say for the specific lines?
git blame <remote>/main -- <file> | grep -A2 -B2 "<pattern>"
```

### Check related branches

```bash
# Is someone already working on a fix?
git branch -r | grep -i "<keyword>"
git log <remote>/<branch> --format='%an | %s' -5
```

## Phase 3: Write the Issue

Adapt the structure to match the project's existing conventions (discovered in Phase 1).
Use this as a baseline — add or remove sections as the project's style dictates:

```markdown
## Description

<What is happening? Include exact error messages. Be specific about where — which
page, endpoint, environment.>

## Root Cause

<WHY it happens. Reference exact file paths, line numbers, and include code snippets.
Explain the logic flaw, not just the symptom.>

## Proposed Solution

<Concrete code changes with before/after snippets. If multiple approaches exist,
list them with tradeoffs and state which one is recommended.>

## Files to Change

| File | Change |
|------|--------|
| `path/to/file` | What to change and why |

## Acceptance Criteria

- [ ] <Specific, testable statement>
- [ ] <Include edge cases and non-regression>
```

### Title conventions

Match the project's existing pattern. If none is apparent, use:

- **Bugs**: `Bug: <component> — <symptom>`
- **UI**: `UI: <description>`
- **Refactor**: `Refactor: <description>`
- **Feature**: `Feat: <description>`

## Phase 4: Create the Issue

```bash
<prefix> glab issue create -R <path> \
  --title "<title>" \
  --label "<label1>,<label2>" \
  --milestone "<milestone>" \
  --description "$(cat <<'EOF'
<issue body using heredoc to preserve formatting>
EOF
)"
```

Always use a heredoc (`<<'EOF'`) for the description to preserve markdown formatting,
code blocks, and special characters.

## Phase 5: Identify and Assign Developers

### Find the right people from git history

```bash
# Primary contributors to the affected files
git log <remote>/main --format='%an <%ae>' -- <file> | sort | uniq -c | sort -rn | head -5

# Who introduced the specific code in question
git log <remote>/main -S "<code-pattern>" --format='%h %an <%ae> | %s' -- <file>

# Who is actively working on related feature branches
git log <remote>/<related-branch> --format='%an <%ae> | %s' -5
```

### Resolve git names to GitLab usernames

Git commit names don't always match GitLab usernames. Search for them:

```bash
# Search project/group members
<prefix> glab api "projects/<url-encoded-path>/members/all" | python3 -c "
import json, sys
for m in json.load(sys.stdin):
    print(f\"{m['username']:30s} {m['name']}\")"

# If not found in project, check group
<prefix> glab api "groups/<group>/members/all" | python3 -c "..."

# If still not found, search all users
<prefix> glab api "users?search=<name>" | python3 -c "..."
```

### Assignment logic

1. **Primary assignee**: Developer who owns the domain or is actively working on a related branch
2. **Secondary assignee**: Developer who introduced the bug or who built the surrounding system
3. Present your reasoning to the user before assigning — let them confirm

```bash
<prefix> glab issue update <number> -R <path> --assignee "user1,user2"
```

## Quality Checklist

Before submitting, verify:

- [ ] Environment was auto-detected (host, project path, glab prefix)
- [ ] Issue format matches the project's existing conventions
- [ ] Root cause identified with specific file paths and line numbers
- [ ] Verified the bug exists on the latest code (not just the deployed version)
- [ ] Proposed solution includes concrete code changes
- [ ] Labels and milestone match project conventions
- [ ] No duplicate of an existing issue
- [ ] Acceptance criteria are specific and testable
- [ ] Assignees are based on git history analysis, not assumptions

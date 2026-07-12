---
globs: "**/*"
---

# Issue Tracking (Work Traceability)

Non-trivial work is tracked in the project's issue tracker, start to finish. The issue trail is
how a team reconstructs what shipped, why, and what it cost — a merged diff without an issue is
an orphan.

## 1. File Before You Build

- **Before starting any non-trivial work**, create an issue in the repo's tracker (GitLab issue,
  GitHub issue — whatever the repo uses). If the tracker groups work into epics/milestones, link
  the issue to the relevant one.
- The issue states the problem, the intended scope, and acceptance criteria — enough that someone
  else could pick it up.
- Trivial one-line fixes may ride an existing issue's scope instead of getting their own; if no
  related issue exists, file one anyway when the change is user-visible.
- If work started without an issue (it happens), file one **before** opening the PR/MR — never
  merge untracked work.

## 2. Reference From the Change

- The PR/MR description references the issue with an auto-closing keyword (`Closes #N`) when the
  change completes it, or a plain reference when it's partial.
- One issue may span several PRs; one PR should not silently complete several issues.

## 3. Close the Loop

- When the work ships (merge, deploy, release), post an outcome note on the issue: what version
  carries it, where it's deployed, anything a future reader needs (known caveats, follow-ups
  filed).
- Discovered follow-up work gets its **own** issue, linked from the note — never left as an
  unrecorded TODO in the conversation.

## 4. No Tracker, No Rule

- Repos without an issue tracker (scratch dirs, throwaway spikes) are exempt. If the repo has a
  tracker but you cannot write to it, say so explicitly and record the issue text in the PR
  description instead.

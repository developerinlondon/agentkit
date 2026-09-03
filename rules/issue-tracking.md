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
- **Tracking work you are about to do is not the same as filing what you noticed.** A review
  finding defaults to being fixed in the change that caused it, and scope carved out of the issue
  in flight is a deferral needing the operator's sign-off. Both are exceptions that have to be
  argued, which is what the `Disposition:` line on a new issue is for — filing is not free, and a
  backlog nobody asked for costs more than the finding did.
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

## 4. No Deferred Findings

- A finding surfaced while doing a job — a bug hit mid-task, a review comment, a gap noticed in
  passing — is fixed in the same change, or in one consolidating MR before the job is reported done.
  It is not filed and walked away from.
- An issue may be filed for a finding only when: (a) the owner explicitly deferred it — quote their
  words, or (b) it is blocked on something outside your control — name the blocker. Nothing else
  qualifies, including "non-blocking", "tech debt", "nice to have", or "follow-up".
- Say which case it is with a `Disposition:` line in the issue body:
  - `Disposition: owner-deferred — <the owner's own words>`
  - `Disposition: owner-request — <the owner's own words>` (the owner asked for this issue)
  - `Disposition: blocked-by <the external system, person, or permission>`
- Before reporting a job done, every issue the session opened is either closed by a merged change or
  carries one of those dispositions. `issue-police` enforces the `Disposition:` line and its form
  mechanically; it cannot tell whether the case claimed is true.

## 5. No Tracker, No Rule

- Repos without an issue tracker (scratch dirs, throwaway spikes) are exempt. If the repo has a
  tracker but you cannot write to it, say so explicitly and record the issue text in the PR
  description instead.

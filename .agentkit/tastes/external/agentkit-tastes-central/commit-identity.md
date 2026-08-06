---
name: commit-identity
scope: external
category: git
strength: require
enforce: check
provenance: 2026-08-05 · seeded from the owner's standing global instruction; the GitLab half was corrected after merge requests were opened under a handle that does not exist
---

Commits are authored as Nayeem Syed and GPG-signed with key 11F993FCF5EEE14C. On GitHub the
email is developerinlondon@gmail.com; in the bizfoundry GitLab group it is smn7818@gmail.com,
set per repository. Never tech@fullcircleinvestmentpartners.com or any other address.

Why: the signing key carries both user IDs, so the global signing configuration already works
and only the email needs overriding per repository. A wrongly attributed or unsigned commit is a
history rewrite to fix, not an edit — and the GitLab account's only real handle is
wizardsupreme, so smn7818 as an assignee simply fails to resolve.

How to apply: before the first commit in a repository, confirm the author email matches the
forge, and set the per-repository override in a bizfoundry clone. Verify the signature landed on
that first commit rather than discovering an unsigned run at push time.

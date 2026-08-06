---
name: commit-identity
scope: external
category: git
strength: require
enforce: check
provenance: 2026-08-05 · seeded from the owner's standing global instruction; the GitLab half was corrected after merge requests were opened under a handle that does not exist
---

Commits are authored as Nayeem Syed and GPG-signed with key 11F993FCF5EEE14C. The email is
developerinlondon@gmail.com on GitHub and smn7818@gmail.com in the bizfoundry GitLab group, set per
repository — never tech@fullcircleinvestmentpartners.com.

Why: a wrongly attributed or unsigned commit is a history rewrite to fix, not an edit.

How to apply: the signing key carries both user IDs, so only the email needs overriding. Set and
verify it on the first commit, not at push time.

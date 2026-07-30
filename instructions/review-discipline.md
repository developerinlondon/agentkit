<!-- agentkit:review-discipline:start -->

# Review Discipline

The maker never grades its own work. Before merging or declaring substantive work complete, run
one advisory review pass in a context that did not author the change: a reviewer subagent where
the harness supports one, a fresh session otherwise. Any capable agent given a reviewer brief
works — this discipline names no specific toolkit and depends on none.

Review the committed state (`git show`, `git diff <base>...HEAD`), never the working tree — a
shared checkout can hold abandoned edits that were never proposed. Probe instead of reading: run
the tests, execute the change, try to break it. When the change adds tests or guards, mutate what
they claim to cover and confirm they fail — an assertion that cannot fail is not evidence.

Findings come back ranked by severity, each with a concrete failure scenario, and the author fixes
them rather than arguing them down. After fixes, ask the same reviewer for a delta re-review; full
re-reviews are for new scope, not fixups. Merge on approval. Absent the `strict-review` group, the pass
is advisory — no mechanism blocks the merge — so the cost is one review per substantive change,
and nothing forces a re-review for every fixup commit.

Trivial changes — typos, labels, comment wording, config value tweaks — are exempt. Repos where a
bad merge is expensive escalate by opting into the `strict-review` group (`--with strict-review`), which layers
evidence records and a hard merge gate on top of this discipline.

<!-- agentkit:review-discipline:end -->

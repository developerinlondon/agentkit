# Serialize Shared-State Mutations

When multiple agents or processes can touch the same state — a branch, a file,
a database row, an index — mutations need a single writer or an explicit lock.
Read-copy-merge races and "last write wins" lose work silently. Prefer
append-only records, per-owner files, or a queue over in-place concurrent edits.

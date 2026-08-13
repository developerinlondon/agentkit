# Make Operations Idempotent

Any operation an agent may run twice — installers, migrations, seeders, sync
jobs — must converge to the same state on re-run, not fail or duplicate.
Check-then-act with a stable key beats generate-always. Idempotence is what
makes retries, resumed sessions, and concurrent agents safe.

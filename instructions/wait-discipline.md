<!-- agentkit:wait-discipline:start -->

# Wait Discipline

Delegated work is finished when its artefact says so, not when a message arrives. A notification
can be dropped, delayed past a session-limit window, or swallowed by a harness restart, and a
session that waits on one alone sits idle with the work already done until a human notices.

Never end a turn waiting on a notification. Before handing back while a subagent, background
command, or remote job is still running, arm a poll on the artefact the work produces: the branch
head, the pull request's checks, a file the job writes, a deploy stamp, a URL that starts
answering. Poll the artefact rather than the messenger, because the artefact is what the next step
actually needs.

Every poll carries a deadline. `wait-for` is one line and exits either way:

```sh
wait-for --cap 1800 --every 30 --sha /path/to/repo origin/main
wait-for --cap 1800 --every 30 --pr-checks owner/repo 437
wait-for --cap 1800 --every 60 --file-match /path/to/record.json '"status": *"done"'
wait-for --cap 900 --every 30 --url https://example.test/health --status 200
```

Run it with the harness's background facility so the turn can still end, and size the cap to the
work: a CI run is minutes, a review pass is tens of minutes, a deploy is somewhere between. A bare
`--watch` or an uncapped sleep loop is not a poll — it ends when the thing it watches ends, which
is the failure being guarded against.

Act when the deadline passes. The cap expiring is information: the work is late, and lateness is
worth reporting or chasing. Re-arm the poll once with a longer cap if the delay is explainable,
then escalate to the person who asked rather than arming a third.

Tell the owner the deadline. When you do hand back with work outstanding, say in the reply what
you are waiting on, which deadline you are waiting to, and what you will do when it passes. A
handoff that names no deadline is how work goes quiet.

<!-- agentkit:wait-discipline:end -->

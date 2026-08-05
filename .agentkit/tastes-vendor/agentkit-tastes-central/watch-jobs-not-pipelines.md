---
name: watch-jobs-not-pipelines
scope: external
category: delivery
strength: require
provenance: 2026-07-11 · a five-second neutron job hung running for twenty-seven minutes behind a bare terminal-state wait loop, and the owner had to ask why it was taking so long
---

Never wait on a pipeline, deploy or rollout with a loop that only watches for a terminal state.
Watch job-level state against an expected duration, and say something the moment a job stalls.

Why: terminal-state polling cannot tell working from wedged, so a stuck job burns its full
timeout — often an hour — in a silence that reads as progress.

How to apply: poll the jobs, emit a line on every state change, and emit a stall line when a job
sits in one non-terminal state past its budget — roughly two minutes for validate and version
jobs, fifteen for a container build, five for a pod rollout. On a stall, diagnose immediately
rather than reporting: runner assignment, the runner service log, whether the container daemon
responds. Then cancel and retry the orphaned job. On the eda host the known cause is anything
that restarts the runner container mid-job.

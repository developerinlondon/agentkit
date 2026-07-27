# Product Brief: acme-notes

## Executive Summary

acme-notes is a note-taking app for solo developers whose notes live as
plain markdown files inside a git repository the user already owns
[C-003]. Where hosted note SaaS keeps your thinking on someone else's
server, acme-notes versions it next to the code it explains — greppable,
diffable, and readable with any editor. The product is active, with v1.4.0
released 2026-07-02 [C-005].

## The Problem

Debugging notes, decision trails and half-finished thoughts die in chat
scrollback and hosted apps that outlive nobody's subscription. For a solo
developer [C-004], the cost is re-deriving yesterday's dead ends.

## The Solution

Notes are markdown files in your repo [C-003]. Writing one is `execute`
(edit next to the code); committing is `conclude` (the note lands in
history with the change it explains).

## What Makes This Different

No lock-in is the moat that can be proven: clone the repo and the notes
are yours with any editor [C-003]. No fabricated technical moats beyond
that — the rest is scope discipline.

## Who This Serves

Solo developers on personal projects [C-004]. Team features are neither
advertised nor evidenced.

## Open Contradiction

The pricing page caps the free tier at three projects [C-001]; the README
says five [C-002]. Both sources are current as of 2026-07-27. Unresolved —
see findings.

## Not Verified

- SOC 2 certification [C-007]: no audit report or trust page reachable.
- Sync conflict dialog behavior: static acquisition cannot exercise the
  running app.

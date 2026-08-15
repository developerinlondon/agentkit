---
name: agentauthz
description: >-
  Administer an agentauthz host over its MCP tools (authz_describe, authz_check,
  authz_grant, authz_grants, authz_revoke, authz_policies, authz_audit_query):
  read the descriptor before touching vocabulary, grant curated policies bounded
  down, probe-check both directions after every change, verify in the audit
  trail. Triggers: granting or revoking access, authoring or validating authz
  policy, "why was this denied", bounds, condition keys, agentauthz, authz MCP
  tools.
---

# agentauthz over MCP

An agentauthz host exposes its authorization engine as MCP tools. The engine is
deny-wins and asymmetrically fail-closed: an erroring or invalid condition on an
allow fails the allow, a deny always stands. Every mutation you make is
attributed and audited as you.

The tool schemas are generated from the host's descriptor. When a schema offers
you a field, the host declared it; when it doesn't, the vocabulary does not
exist — do not improvise around it.

## The workflow

```
authz_describe ──▶ pick policy ──▶ authz_grant (bounded) ──▶ probe both ways ──▶ authz_audit_query
     │                 │                    │ named error?                │
     └ vocabulary      └ authz_policies     └ fix the named field,        └ your write + the
       is data           before authoring     re-submit                     probes, on record
```

**1. Describe before anything.** Call `authz_describe` first in any session that
touches authorization. Actions, condition keys (with the operators their type
admits), and scope kinds are host data, not general knowledge. An action or key
you remember from another host does not exist here.

**2. Grant narrow, not author broad.** Check `authz_policies` for a curated
policy that covers the need, then `authz_grant` it **with bounds** that narrow
it to the subject's actual situation (region, resource class, time — whatever
the condition keys offer). Bounds AND onto the policy's _allow_ statements only;
they can never widen anything. Prefer one bounded grant of an existing policy
over proposing a new, broader policy.

**3. Re-granting replaces bounds.** A second `authz_grant` for the same policy,
subject and scope does not merge with the first — its bounds replace the old
ones entirely. Read the existing grant (`authz_grants`) before re-granting, and
carry forward any bound you intend to keep.

**4. Validation errors are instructions.** Rejections come back with the
engine's own message naming the field, key, or operator at fault. Correct
exactly what the message names and re-submit. Do not retry unchanged, weaken the
request until it passes, or switch to a different tool to route around a
rejection — a rejected bound means the vocabulary or shape was wrong, not that
the operation needs more force.

**5. Probe both directions after every change.** A grant that "succeeded" is a
row, not an outcome. Immediately `authz_check`:

- **positive probe** — the subject/action/resource (with context matching the
  bounds) that must now be allowed;
- **negative probe** — an adjacent case that must STILL be denied: outside the
  bounds' region, a sibling action, a scope above the granted one.

Deny-wins means an unrelated deny statement can override your fresh grant — only
the positive probe proves the access exists. And bounds only bind if the
negative probe fails — a grant whose negative probe unexpectedly passes is wider
than intended: revoke it and reread the policy before trying again.

**6. Close with the audit trail.** `authz_audit_query` for the subject you
touched: your grant/revoke rows and your probes should be there. Cite the
decision rows, not your intent, when reporting what changed.

## Revocation

`authz_revoke` takes a grant id — get it from `authz_grants` (filter by subject,
policy, or scope), never from memory. After revoking, run the old positive probe
and expect a deny; access that survives revocation means another grant or an
open-mode baseline is supplying it — find it with `authz_grants` before
escalating.

## What you never do

- Invent actions, condition keys, operators, or scope kinds not in the
  descriptor.
- Grant without bounds when the descriptor offers a key that fits the
  situation's natural limits.
- Treat a deny as an error to engineer around. A deny is the system working;
  surface it to the operator with the audit row.
- Assume checks are free of side effects on your report: every check is audited,
  so a wall of speculative probes is visible noise in the host's trail. Probe
  what you need to prove.

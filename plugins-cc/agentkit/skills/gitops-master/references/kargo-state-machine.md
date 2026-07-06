# Kargo State Machine Rules

The 8 facts about how Kargo tracks promotion state internally:

```
KARGO STATE MACHINE (from regular_stages.go):
==============================================

1. lastPromotion is ONLY set when currentPromotion != nil
   (line 637 in regular_stages.go)

2. Promotion names are compared LEXICOGRAPHICALLY
   - Auto-generated names use timestamps: "foundation.01jkx..."
   - Manually-created names that sort AFTER auto ones break anti-loop logic
   - This is the #1 cause of "poisoned stage state"

3. Anti-loop protection:
   - If ANY terminal promotion exists for this freight, Kargo won't re-promote
   - Prevents infinite promote -> fail -> promote cycles
   - BUT: a manually-errored promotion counts as terminal, blocking ALL future
     auto-promotions for that freight

4. Sequential gate pipeline:
   promotion -> health -> verification -> verified -> auto-promote next
   Each gate BLOCKS all subsequent gates if stuck in non-terminal state

5. freightHistory tracks what freight the stage has successfully promoted
   - Empty freightHistory = no successful promotion ever ran
   - Stale freightHistory = lastPromotion is stuck, blocking freight tracking

6. Stage health is ONLY assessed when lastPromotion.status.phase == Succeeded
   - If lastPromotion is stuck in Errored, health checks never run

7. Verification ONLY runs after health checks pass
   - If health gate is blocked, verification never starts
   - AnalysisRun Jobs are created only after health passes

8. The "less than 10 seconds" rule:
   - After ArgoCD sync, Kargo doesn't trust health for 10 seconds
   - This prevents false-positive health from stale ArgoCD status
```

## Kargo Step Retry Configuration

```yaml
# DEFAULT VALUES (often too aggressive):
#   argocd-update timeout: 5 minutes
#   errorThreshold: 1 (NO retries - single failure aborts)

# RECOMMENDED for heavy apps (kube-prometheus-stack, loki, etc.):
steps:
  - uses: argocd-update
    config:
      apps: [...]
    retry:
      timeout: 10m # Allow 10 minutes for large chart sync
      errorThreshold: 3 # Retry up to 3 times on transient failures

# RECOMMENDED for lightweight apps (configmaps, simple deployments):
steps:
  - uses: argocd-update
    config:
      apps: [...]
    retry:
      timeout: 5m
      errorThreshold: 2
```

**KEY FACTS about retry**:

- Retry config goes on EACH step, not globally on the stage
- `errorThreshold: 1` (default) = NO retries, first failure is fatal
- `timeout` controls how long the step can run total, not per-retry
- Transient "connection refused :8081" errors are the #1 reason to add retries
- ArgoCD repo-server OOM-restarts are common with large charts (prometheus, loki)

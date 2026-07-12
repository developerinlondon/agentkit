# ArgoCD Sync Failure Taxonomy

| Error Pattern                   | Root Cause                           | Fix                                              |
| ------------------------------- | ------------------------------------ | ------------------------------------------------ |
| "connection refused :8081"      | repo-server down/restarting          | Wait + retry config, check repo-server pod       |
| "one or more sync tasks failed" | PostSync hooks or resource apply err | Check app `.status.operationState.syncResult`    |
| "ComparisonError"               | Manifest generation failed           | Check repo-server logs, helm chart validity      |
| "OutOfSync" after sync          | Ignored differences not configured   | Add `ignoreDifferences` to Application           |
| "Degraded" health               | Pod CrashLoop / OOM                  | Check pod events, resource limits                |
| "Unknown" health                | Resource has no health check defined | Add custom health check or ignore                |
| "Progressing" stuck             | Deployment rollout stuck             | Check pod scheduling, resource quotas, PVC binds |
| "SyncError" on CRDs             | CRD applied before operator ready    | Ensure operator deploys in earlier stage         |
| "rpc error: code = Unavailable" | ArgoCD API server overloaded         | Check argocd-server pod resources                |

**IMPORTANT**: ArgoCD shows stale `operationState`. Always check the `finishedAt` timestamp, not
just the error message. An error from 3 hours ago is not the current problem.

## Debugging Commands

```bash
# Check when the last operation actually finished
${SSH_CMD} kubectl get app <name> -n ${ARGOCD_NS} \
  -o jsonpath='{.status.operationState.finishedAt}'

# Check repo-server logs (common failure point)
${SSH_CMD} kubectl logs -n argocd deploy/argocd-repo-server --tail=50

# Check ArgoCD app sync status
${SSH_CMD} kubectl get app <app-name> -n ${ARGOCD_NS} \
  -o jsonpath='{.status.sync.status} {.status.health.status}'
```

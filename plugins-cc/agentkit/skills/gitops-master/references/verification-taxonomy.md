# Verification Taxonomy (4 Levels)

```
+--------------------------------------------------------------+
|                  Verification Levels                          |
+--------------------------------------------------------------+
|                                                               |
|  Level 1: Infrastructure (pods, CRDs, secrets)                |
|  +-- Pods running in correct namespace                        |
|  +-- Required CRDs installed                                  |
|  +-- Secrets exist with expected keys                         |
|  +-- PVCs bound, storage available                            |
|                                                               |
|  Level 2: Service Health (endpoints, readiness)               |
|  +-- Health/readiness endpoints responding                    |
|  +-- Internal service-to-service connectivity                 |
|  +-- Database/queue connections established                   |
|  +-- Metrics endpoint scraping (Prometheus targets > 0)       |
|                                                               |
|  Level 3: Ingress & Auth (external access, SSO)               |
|  +-- External URL accessible (via ingress/tunnel)             |
|  +-- SSO redirect works (302 to auth provider)                |
|  +-- Service account / API key auth works                     |
|  +-- OAuth2-proxy header injection working                    |
|  +-- TLS certificate valid                                    |
|                                                               |
|  Level 4: Functional (user-facing features work)              |
|  +-- Dashboard loads with real data                           |
|  +-- Query API returns expected results                       |
|  +-- Data pipeline ingesting (logs flowing to Loki)           |
|  +-- Alerts configured and firing test alert                  |
|                                                               |
+--------------------------------------------------------------+
```

## Per-Stage Verification Matrix (Example)

Adapt these checks to your actual stages and applications.

### Foundation Stage (Example)

| Level | What to Check                       | Command                                                                                       |
| ----- | ----------------------------------- | --------------------------------------------------------------------------------------------- |
| L1    | ArgoCD, Kargo, Traefik pods         | `kubectl get pods -n argocd && kubectl get pods -n kargo && kubectl get pods -n ${ARGOCD_NS}` |
| L1    | Cert-manager CRDs                   | `kubectl get crd certificates.cert-manager.io`                                                |
| L2    | ArgoCD API responds                 | `kubectl exec -n argocd deploy/argocd-server -- wget -qO- http://localhost:8080/healthz`      |
| L2    | Kargo API responds                  | `kubectl exec -n kargo deploy/kargo-api -- wget -qO- http://localhost:8443/healthz`           |
| L3    | ArgoCD dashboard accessible via SSO | Check external URL: `argocd.${DOMAIN}`                                                        |
| L4    | ArgoCD can discover and sync apps   | `kubectl get applications -n ${ARGOCD_NS}`                                                    |

### Operators Stage (Example)

| Level | What to Check                 | Command                                                                                     |
| ----- | ----------------------------- | ------------------------------------------------------------------------------------------- |
| L1    | ESO controller + webhook pods | `kubectl get pods -n ${ARGOCD_NS} -l app.kubernetes.io/name=external-secrets`               |
| L1    | ESO CRDs installed            | `kubectl get crd externalsecrets.external-secrets.io`                                       |
| L1    | Crossplane pods + providers   | `kubectl get pods -n crossplane-system`                                                     |
| L2    | ESO controller ready          | `kubectl get deploy -n ${ARGOCD_NS} external-secrets -o jsonpath='{.status.readyReplicas}'` |
| L4    | ClusterSecretStore connected  | `kubectl get clustersecretstore -o jsonpath='{.items[*].status.conditions[0].status}'`      |

### Monitoring Stage (Example)

| Level | What to Check                         | Command                                                                                                                       |
| ----- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| L1    | Prometheus, Grafana, Loki, Alloy pods | `kubectl get pods -n ${MONITORING_NS}`                                                                                        |
| L1    | Prometheus PVC bound                  | `kubectl get pvc -n ${MONITORING_NS}`                                                                                         |
| L2    | Prometheus targets scraping           | `kubectl exec -n ${MONITORING_NS} deploy/kube-prometheus-stack-prometheus -- wget -qO- http://localhost:9090/api/v1/targets`  |
| L2    | Loki readiness                        | `kubectl exec -n ${MONITORING_NS} deploy/loki -- wget -qO- http://localhost:3100/ready`                                       |
| L2    | Grafana health                        | `kubectl exec -n ${MONITORING_NS} deploy/kube-prometheus-stack-grafana -- wget -qO- http://localhost:3000/api/health`         |
| L3    | Grafana SSO login                     | Check external URL: `logs.${DOMAIN}`                                                                                          |
| L4    | Logs flowing to Loki                  | Query Loki via Grafana for recent log entries                                                                                 |
| L4    | Alertmanager receiving alerts         | `kubectl exec -n ${MONITORING_NS} deploy/kube-prometheus-stack-alertmanager -- wget -qO- http://localhost:9093/api/v2/status` |

## Verification RBAC Checklist

When Kargo runs AnalysisRun verification Jobs, the Job's ServiceAccount needs explicit RBAC for
every resource it accesses. Missing RBAC causes SILENT failures.

| What the Verification Job Does | Required RBAC                             |
| ------------------------------ | ----------------------------------------- |
| `kubectl get pods`             | `pods: [get, list]`                       |
| `kubectl get applications`     | `applications.argoproj.io: [get, list]`   |
| `kubectl get secrets`          | `secrets: [get, list]`                    |
| `kubectl get configmaps`       | `configmaps: [get, list]`                 |
| `kubectl get <CRD>`            | `<crd-resource>.<api-group>: [get, list]` |
| `curl internal service`        | No RBAC needed (network policy only)      |
| `curl external URL`            | No RBAC needed (egress network policy)    |

**DEBUGGING RBAC FAILURES:**

```bash
# 1. Find the AnalysisRun
${SSH_CMD} kubectl get analysisruns -n ${KARGO_NS} \
  --sort-by=.metadata.creationTimestamp

# 2. Find the Job it created
${SSH_CMD} kubectl get jobs -n ${KARGO_NS} \
  --sort-by=.metadata.creationTimestamp

# 3. Check Job logs for RBAC errors
${SSH_CMD} kubectl logs job/<job-name> -n ${KARGO_NS}

# 4. If "forbidden" error: check which ServiceAccount the Job uses
#    and what ClusterRole/Role is bound to it
```

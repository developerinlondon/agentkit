---
globs: ["gitops/**/*.yaml", "gitops/**/*.yml"]
---

# Credential Bootstrap Pattern (MANDATORY)

Every app that needs secrets MUST use the OpenBao + ESO credential bootstrap pattern. NEVER
hardcode passwords, generate random passwords in Helm values, or use `kubectl create secret`.

## Architecture

```
PreSync (-2)                   PreSync (-1)                   Sync (0)
+------------------------+     +------------------------+     +------------------------+
| presync-rbac.yaml      |     | presync-bootstrap.yaml |     | externalsecret.yaml    |
|                        |     |                        |     |                        |
| ServiceAccount         |     | ConfigMap (Lua script) |     | ExternalSecret         |
| Role (get openbao-     |     | Job (runs assay)       |     |   secretStoreRef:      |
|   root-token)          |     |                        |     |     openbao (CSS)      |
| RoleBinding            |     | vault.ensure_creds()   |     |   remoteRef:           |
+------------------------+     |   - idempotent         |     |     secrets/data/      |
                               |   - generates if       |     |     platform/{app}     |
                               |     missing            |     |                        |
                               |   - skips if exists    |     | Creates K8s Secret     |
                               +------------------------+     +------------------------+
                                         |                              |
                                         v                              v
                               +-------------------+         +-------------------+
                               | OpenBao            |         | K8s Secret        |
                               | secrets/data/      |-------->| {app}-credentials |
                               |   platform/{app}   |  ESO    |                   |
                               +-------------------+  syncs   +-------------------+
```

## When to Use

- App needs database credentials (username/password)
- App needs admin passwords (Grafana, Paperless, etc.)
- App needs API keys or tokens that should be auto-generated
- Any secret that should persist across redeployments

## Required Files (3 templates per app)

### 1. `templates/presync-rbac.yaml` -- ServiceAccount + RBAC

Allows the bootstrap Job to read the OpenBao root token from the secrets namespace.

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: {app}-bootstrap
  namespace: {{ .Release.Namespace }}
  labels:
    app.kubernetes.io/name: {app}
    app.kubernetes.io/component: bootstrap
    app.kubernetes.io/managed-by: {{ .Release.Service }}
  annotations:
    argocd.argoproj.io/hook: PreSync
    argocd.argoproj.io/hook-delete-policy: BeforeHookCreation
    argocd.argoproj.io/sync-wave: "-2"
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: {app}-bootstrap-reader
  namespace: {{ .Values.openbao.namespace | default "secrets" }}
  # ... same labels/annotations, sync-wave: "-2"
rules:
  - apiGroups: [""]
    resources: ["secrets"]
    resourceNames: ["openbao-root-token"]
    verbs: ["get"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: {app}-bootstrap-reader
  namespace: {{ .Values.openbao.namespace | default "secrets" }}
  # ... same labels/annotations, sync-wave: "-2"
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: {app}-bootstrap-reader
subjects:
  - kind: ServiceAccount
    name: {app}-bootstrap
    namespace: {{ .Release.Namespace }}
```

### 2. `templates/presync-bootstrap.yaml` -- Lua Script + Job

The assay Lua script uses `vault.ensure_credentials` which is **idempotent** -- it only generates
credentials if the specified check key is missing.

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: {app}-bootstrap-script
  namespace: {{ .Release.Namespace }}
  annotations:
    argocd.argoproj.io/hook: PreSync
    argocd.argoproj.io/hook-delete-policy: BeforeHookCreation
    argocd.argoproj.io/sync-wave: "-1"
data:
  bootstrap.lua: |
    #!/usr/bin/env assay
    local vault = require("assay.vault")
    local bao_url = env.get("BAO_ADDR")
    local secrets_ns = env.get("SECRETS_NAMESPACE")
    local vlt = vault.authenticated_client(bao_url, { secret_ns = secrets_ns })

    vault.ensure_credentials(vlt, "platform/{app}", "{check_key}", function()
      return {
        key1 = "value1",
        key2 = crypto.random(32),
      }
    end)
    log.info("{App} bootstrap complete")
---
apiVersion: batch/v1
kind: Job
metadata:
  name: {app}-bootstrap
  namespace: {{ .Release.Namespace }}
  labels:
    app.kubernetes.io/name: {app}
    app.kubernetes.io/component: bootstrap
    app.kubernetes.io/managed-by: {{ .Release.Service }}
  annotations:
    argocd.argoproj.io/hook: PreSync
    argocd.argoproj.io/hook-delete-policy: BeforeHookCreation
    argocd.argoproj.io/sync-wave: "-1"
spec:
  backoffLimit: 5
  template:
    metadata:
      labels:
        app.kubernetes.io/name: {app}
        app.kubernetes.io/component: bootstrap
    spec:
      serviceAccountName: {app}-bootstrap
      restartPolicy: Never
      containers:
        - name: bootstrap
          image: ghcr.io/developerinlondon/assay:{{ .Values.assay.imageTag }}
          imagePullPolicy: Always
          env:
            - name: BAO_ADDR
              value: {{ .Values.openbao.url | default "http://openbao.secrets.svc:8200" | quote }}
            - name: SECRETS_NAMESPACE
              value: {{ .Values.openbao.namespace | default "secrets" | quote }}
          command: ["assay", "/scripts/bootstrap.lua"]
          volumeMounts:
            - name: scripts
              mountPath: /scripts
      volumes:
        - name: scripts
          configMap:
            name: {app}-bootstrap-script
```

### 3. `templates/externalsecret.yaml` -- ESO ExternalSecret

```yaml
apiVersion: external-secrets.io/v1
kind: ExternalSecret
metadata:
  name: {app}-credentials
  namespace: {{ .Release.Namespace }}
  labels:
    app.kubernetes.io/name: {app}
    app.kubernetes.io/component: credentials
    app.kubernetes.io/managed-by: {{ .Release.Service }}
  annotations:
    argocd.argoproj.io/sync-wave: "0"
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: openbao
    kind: ClusterSecretStore
  target:
    name: {app}-credentials
    creationPolicy: Owner
    deletionPolicy: Retain
    template:
      engineVersion: v2
      mergePolicy: Replace
      data:
        key1: "{{ `{{ .key1 }}` }}"
        key2: "{{ `{{ .key2 }}` }}"
  data:
    - secretKey: key1
      remoteRef:
        key: secrets/data/platform/{app}
        property: key1
        conversionStrategy: Default
        decodingStrategy: None
        metadataPolicy: None
    - secretKey: key2
      remoteRef:
        key: secrets/data/platform/{app}
        property: key2
        conversionStrategy: Default
        decodingStrategy: None
        metadataPolicy: None
```

## Key Rules

1. **NEVER hardcode secrets** in values.yaml or templates -- always use OpenBao + ESO
2. **vault.ensure_credentials is idempotent** -- safe to run repeatedly, only generates on first run
3. **check_key parameter** -- the second arg to ensure_credentials is the key to check for
   existence. Pick the most important key (usually `password` or `admin_password`)
4. **OpenBao path convention** -- always `platform/{app}` under the `secrets` KV mount
5. **Sync waves matter** -- RBAC at -2, bootstrap Job at -1, ExternalSecret at 0, app resources at
   1+
6. **deletionPolicy: Retain** -- always set on ExternalSecret target so secrets survive app deletion
7. **For upstream Helm charts** that generate random secrets (like Grafana), use the chart's
   `existingSecret` option to point at the ESO-managed secret instead

## Existing Examples

| App                  | OpenBao Path           | Check Key      |
| -------------------- | ---------------------- | -------------- |
| postgres             | platform/postgres      | password       |
| redis                | platform/redis         | password       |
| mariadb              | platform/mariadb       | rootPassword   |
| zitadel              | platform/zitadel       | masterkey      |
| seafile              | platform/seafile       | adminPassword  |
| immich               | platform/immich        | adminPassword  |
| paperless            | platform/paperless     | adminPassword  |
| kube-prometheus-stack | platform/grafana       | admin_password |

# acme-platform — workspace orientation

Rules engine plus operator console, sold and supported as one platform rather than as two tools that happen to share a name.

Homepage: <https://acme.example>

`acme-platform` is one product spread across 3 parts. This file
is generated from the product declaration — edit that, then regenerate.

## Parts

| Part      | Role              | Kind    | Where                    | Visibility |
| --------- | ----------------- | ------- | ------------------------ | ---------- |
| `engine`  | core              | repo    | acme/engine              | public     |
| `console` | operator UI       | repo    | acme/console             | public     |
| `cloud`   | hosted deployment | service | https://app.acme.example | private    |

### What each part holds

- **engine** — The rules engine itself, its CLI, and the wire format the console speaks. The part a user installs.
- **console** — Web console for authoring and inspecting rule sets. Ships separately because it is optional; the engine runs headless.
- **cloud** — The managed instance. Not a repository — it is where the two repos above are observed running together.

## Evidence and published page

- brief: `brief.yaml`
- ledger: `ledger.yaml`
- site entry: `index.md`
- published at: <https://pages.acme.example/acme-platform>

Paths are relative to the product declaration.

## Working here

Each part above is a separate repo or service with its own clone. A component
names the part it is via `part_of` in its `.agentkit/product.yaml`; that marker
and this declaration must agree on the id, so `acme-platform` is
discoverable from either end.

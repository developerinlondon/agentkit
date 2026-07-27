# Worked examples

Each directory is a complete, schema-valid artifact set for one evidence
situation. The subjects are fictional; the shapes are the contract.

| Example         | Demonstrates                                                                                                                               |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `website-only/` | Site locators only; repo-side facts land in `cannot_verify`, not guesses                                                                   |
| `repo-only/`    | Repo + release locators; adoption/registry facts are `cannot_verify`                                                                       |
| `mixed/`        | Both surfaces, an unresolved contradiction rendered in the brief, and the full set: `brief.yaml`, `ledger.yaml`, `brief.md`, `findings.md` |

Validate any of them:

```sh
bun skills/product-intelligence/scripts/validate.ts skills/product-intelligence/examples/mixed/brief.yaml
```

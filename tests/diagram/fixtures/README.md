# Extractor fixtures

Every JSON file here is output of the tool named below, captured on 2026-07-28.
None was hand-written, and no value in any of them was altered: a transform
tested against an idealised input is tested against the wrong thing. The only
edit any of them received is whitespace — the repository formatter runs over
every JSON file, and `tofu show -json` emits a single compact line.

| Fixture                     | Produced by                                                                           |
| --------------------------- | ------------------------------------------------------------------------------------- |
| `depcruise-storefront.json` | `dependency-cruiser` 18.1.0, `depcruise --no-config --output-type json 'src/**/*.ts'` |
| `tbls-publishing.json`      | `tbls` v1.95.0, `tbls out -t json sqlite://pub.db`                                    |
| `tofu-state.json`           | OpenTofu v1.12.5, `tofu show -json` after `tofu apply`                                |
| `k8s-publishing.yaml`       | not a capture — manifests are themselves the source                                   |

`depcruise-storefront.json` comes from a throwaway TypeScript project laid out
as `src/{api,domain,store,web}` with `zod` and `@sindresorhus/is` installed. It
is deliberately not a capture of this repository: agentkit's own module graph
changes whenever a file is added, which would churn the fixture on unrelated
work. The live self-test against this repository lives in the test file and
skips when `depcruise` is absent.

Two properties of these captures are load-bearing and easy to lose if anyone
regenerates them:

- `depcruise-storefront.json` contains **duplicate module entries** — a file
  matched by the glob and also imported by another file is listed twice — and
  `store` imports `domain` while `domain` imports `store`, so the layering
  cycle is real rather than staged.
- `tofu-state.json` was captured from a configuration chosen to hold **no
  sensitive attribute**. `tofu show -json` normally embeds secrets in plain
  text (`random_password.result`, `tls_private_key.private_key_pem`); that is
  why the extractor never reads `values`, and why regenerating this fixture
  needs the same care.

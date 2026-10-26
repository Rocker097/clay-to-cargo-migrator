# Adaptability milestone (v0.3)

This extends the deterministic compiler; it does not claim universal schema support or 70–80% customer coverage.

## What changed

- Versioned workflow representation in inspection output: operations, typed outputs, expression trees, dependencies and execution stage.
- Formula result inference replaces inaccurate text metadata. Mixed incompatible result types are blocked; type information flows through dependencies.
- Loader methods: uppercase/lowercase, trim, includes, startsWith, endsWith, literal replacement, slice and substring. Supported method chains retain optional-chain short-circuiting. Null/undefined, `??`, and nullish COALESCE preserve zero and false. No arbitrary method execution, arrays, regex or object scripts.
- Mapping JSON can choose a reviewed adapter and declare compatible input/output aliases. Aliases cannot invent new Cargo fields or provider signatures. They are marked for review.
- Stricter CSV inputs, explicit stable source identities, remote existing-row checks and a local checkpoint. Identical reimports skip existing rows; changed inputs stop rather than overwrite. A lost response does not trigger an automatic repeat create.
- Opt-in enrichment reuse for scalar output columns that fully satisfy a mapped action's downstream fields. The wrapper returns the imported fields before making a paid provider call. Incomplete exports fall back to enrichment. AI outputs are not automatically reused.

## Inspect, compile and evaluate

Requires Node 24.

```bash
npm ci
npm test
npm run evaluate
npm run inspect -- --schema tests/fixtures/fifteen-column.claymate.json
npm run compile -- --schema tests/fixtures/fifteen-column.claymate.json --name fifteen_column_test --out examples/fifteen-column-test
npx cargo-ai project check --dir examples/fifteen-column-test/infra
```

`evaluation/cases.json` contains **20 authored synthetic cases and two configurations originating from real Clay exports**. Development/holdout labels divide authored fixtures only; they are not independent customer validation. The report separates origins, reports full-workflow generation and column translation, and checks expected failures as well as local calculations. It makes no live provider calls. The two real configurations belong to this prototype, not a representative market sample.

To add an independent customer case, obtain permission, strip credentials/identifiers, add its configuration, mark origin `real-export`, and supply independently verified expected outputs. Never mark generated examples as real exports. Full provider equivalence requires a separate pilot.

## Mapping configuration

```json
{
  "actions": {
    "bespoke-company-lookup": {
      "adapter": "company-from-domain",
      "inputAliases": { "domain": "company_site" },
      "outputAliases": { "profile": "linkedin_url" }
    }
  }
}
```

Use the same `--mappings file.json` for inspect, compile and parity. These aliases require semantic review; a field with a similar label may mean something different.

## Generated loader

Run from a project with the pinned Cargo CLI installed. This preview makes no Cargo calls:

```bash
node examples/fifteen-column-test/scripts/clay-fifteen-column-test/load-rows.ts --csv /path/to/export.csv --id-column Domain --source clay-pilot --limit 2 --reuse-existing
```

Only add `--model-uuid ACTUAL_MODEL_UUID --execute` after reviewing the preview and deploying that exact model. Stable IDs must uniquely identify source records: Domain is suitable only for a company table with one row per domain, not a contacts table. Use an immutable source record ID where available.

The generated loader now refuses live execution without `--id-column`. Do not reuse old row-number imports as if they had the new namespaced identity.

## Operational limits

- Existing row comparison uses the CLI's documented record list/create surface and fails closed on unrecognized response shapes. The native list/get response shapes were checked read-only against this workspace. The importer refuses a refreshing snapshot. The revised importer and reuse guard have local tests with simulated responses; **they have not been validated in a new live Cargo import**.
- Read-check-create is not atomic server-side upsert. A checkpoint lock serializes local runs but cannot prevent a concurrent import from another machine. Cross-machine guarantees require a unique server-side source key or supported atomic upsert.
- If a create may have succeeded but is not yet visible, the checkpoint blocks retry. Reconcile remote state and any stale lock before changing the checkpoint. Never delete it merely to bypass a warning.
- Changed existing inputs are rejected; automatic updates and clearing/re-enrolling stale workflow results are not implemented.
- Reusing outputs is explicit and does not assert source-to-Cargo provider parity. AI answers, arbitrary provider JSON, CRM writes, cross-table lookups and continuous formula recalculation remain limited or unsupported.
- The evaluation percentage describes this small authored suite only. A 70–80% customer-workflow claim needs representative independent schemas, held-out testing and live output checks.

No new resources are deployed and no provider calls run by these local evaluation commands.

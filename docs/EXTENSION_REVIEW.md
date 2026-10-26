# AI-assisted adapter review

The compiler remains deterministic. An assistant can propose configuration changes; it cannot install arbitrary code or invent Cargo actions through this interface.

## Workflow

1. Run `node src/cli.ts propose --schema table.json --out review-packet.json`.
2. Review the packet before sharing it with an AI assistant. Account and credential identifiers are removed by key; prompts and formulas can still contain sensitive literals. No network calls happen automatically.
3. Give the packet to your chosen assistant. Save its JSON response as `proposal.json`. The packet includes a response template, unresolved columns and the current adapter contracts. Suggestions must stay within existing, verified contracts. New connector implementations still need code review and tests.
4. Prepare regression cases in the same format as `evaluation/cases.json`. Include the exact source schema, expected blockers, and calculation examples where applicable. Provider semantics require separate sample review/live parity; passing structural fixtures is insufficient.
5. Run `node src/cli.ts review-extension --schema table.json --proposal proposal.json --fixtures cases.json`. This validates only; it does not approve or install anything.
6. A human reviews the evidence, output meanings and test results. To record that decision, run the same command with `--approve --reviewer YOUR_NAME --out approved/mappings-v1.json`.
7. Inspect and compile explicitly using `--mappings approved/mappings-v1.json`. Commit the mappings, `.review.json` audit record and sanitized fixtures to Git after review.

## Guardrails

- Proposals bind to the parsed source schema hash; stale proposals are rejected.
- Only existing adapters, inputs and declared outputs are accepted. Executable suggestions are not run.
- Missing information, unresolved targets, newly broken columns and failing fixtures block approval.
- Regression fixtures must include the reviewed schema. Structural tests do not establish semantic parity.
- Approval requires an explicit CLI flag and reviewer name; existing artifacts cannot be overwritten.
- The audit records proposal/fixture hashes, reviewer, timestamp, local test results and the remaining review items.
- Reviewer names are self-reported, not authenticated signatures. Use protected Git reviews for organizational enforcement.
- The compiler does not automatically discover or load proposal files. Approval does not imply deployment.

## Included example

`outputs/webhook-edge-schema-test/hq-country.proposal.json` is an assistant-authored candidate mapping from Clay `location.country` to the existing `hq_country` output. Validation resolves that blocker and retains the other six. It is **not approved**, and no provider was called. The four calculation assertions verify unrelated formula behavior, not country output equivalence.

## Scope

This implements a provider-independent manual AI handoff: export packet → ask an assistant → import proposal → validate → human approval → explicit compile. It has no built-in hosted model/API integration, automatic learning, or automatic adapter-code generation. Unsupported ingestion, CRM writes and unknown providers remain blockers until implemented and independently verified.

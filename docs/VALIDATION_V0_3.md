# v0.3 validation

- 29 regression tests passed.
- 22 evaluation configurations checked: 20 authored synthetic cases and two real-export configurations. All expected outcomes passed, including deliberate blockers.
- Compiler TypeScript check passed.
- Generated original demo TypeScript check and Cargo validation passed: 11 resources.
- Generated 15-column TypeScript check and Cargo validation passed: 7 resources.
- Cargo list/get response structure checked read-only. Revised upload/reuse behavior is tested locally with simulated responses and generated wrapper execution, not a new paid live migration.

These checks do not establish independent customer coverage, full workflow parity, atomic import guarantees, or a 70–80% migration rate. Nothing newly deployed; GitHub publishing is separate.

# Three-minute walkthrough

0:00 — Show the real Clay schema and explain that CSV values omit provider settings, conditions and formulas.

0:30 — Explain that Cargo already has migration guidance. This compiler explores making its supported translation step repeatable and reviewable.

1:00 — Run npm run demo. Show 6/6 generated, then the report and play. Show npm test and npm run check. These are local checks, not new paid calls.

1:30 — Explain what the first real export broke: order of dependencies, company_identifier, website normalization and expression-based prompts. The original compiler generated only one of six columns; fixes made the translation work.

2:00 — Show the comparison table in docs/REAL_CLAY_COMPARISON.md. Both live Cargo implementations matched Clay's observed business values for one company. AI models and shapes differ. Public local tests replay saved values rather than pretending to call real providers.

2:30 — Close with the limits. This is a working migration accelerator, not proven faster or universal. Next: unseen-table benchmarks, importing existing values, deduplication, native waterfall definitions and broader parity evaluation.

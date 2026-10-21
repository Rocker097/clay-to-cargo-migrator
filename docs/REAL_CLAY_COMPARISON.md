# Real Clay comparison

Tested on 2026-10-21 with a real Clay table and a user-exported ClayMate 1.0 schema. Account references were removed from the public fixture. The table contained a website input, company enrichment, name and employee-count extraction, a 50–1000 employee formula and an AI qualification prompt.

## Method

1. Execute the table in Clay and export its CSV and configuration.
2. Run the original compiler unchanged: only 1/6 columns generated.
3. Repair the compiler and generate all 6 columns.
4. Deploy the generated play and an independently hand-authored translation following Cargo's recipe. Both used the same Cargo model, company provider and AI agent to isolate translation differences.
5. Load two company-only rows, one per approach; verify their stored visibility, manually run both plays and read the saved results back.

The hand-built version was an application of Cargo's published recipe by the same agent, not an official executable, an independent engineer trial or a blind benchmark. The recipe offers other, cheaper company providers; this controlled test kept providers equal.

## Results

| Measure | Compiler-generated | Hand-built recipe translation |
| --- | --- | --- |
| Executed rows | 1 | 1 |
| Status | Success | Success |
| Company name | Notion | Notion |
| Returned employee count | 7211 | 7211 |
| Size flag | false | false |
| AI decision | NOT FIT | NOT FIT |
| Observed run duration | 30.379 seconds | 14.140 seconds |
| Root provider/AI credits reported | 0.7 | 0.7 |

Both match the Clay baseline for the input website, company name, numeric count, boolean flag and semantic AI decision. The provider employee count is not independent ground truth. Clay's AI response included an explanation; Cargo returned JSON with an answer field.

One run per approach, including queueing, cannot establish a performance advantage. Provider/AI credits exclude separate execution charges and are not invoice totals. Clay's credit unit differs, so no cross-platform savings claim is made.

## What changed

- Sort by dependencies instead of assuming export order is execution order; reject cycles.
- Recognize the real company input binding, company_identifier.
- Normalize common website URLs to a domain while keeping the original input.
- Parse supported AI prompt expressions instead of preserving helper code as literal text.

Local regression checks cover six size-rule boundaries, five domain cases, exact prompt text, missing dependencies, unsupported prompt helpers and cycles. Cargo's checker validated the generated graph. A fresh local Git clone passed the documented setup and checks.

## Operational findings and limits

The first batches completed with zero runs while newly imported rows had not yet appeared through stored-model reads. After visibility was confirmed, one manual retry per approach processed one row successfully. Zero-run batches were not counted as successful pilots; automatic retry counts were not measured.

Company enrichment and AI models differ between Clay and Cargo. This proves semantic agreement on one sample, not exact configuration preservation or general migration parity. Both schedules stayed disabled. No CRM, outreach or person lookup was involved. No large-table throughput or productivity improvement was measured.

Raw account-specific traces and deployment IDs are intentionally excluded from this public package. The table's observed public-company values are retained as a local replay fixture. Re-running local tests does not repeat live API calls.

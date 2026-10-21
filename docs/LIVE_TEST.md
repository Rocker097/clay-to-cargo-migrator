# Live test in your own Cargo workspace

Local commands in the README need no account. The steps below create resources, write rows and consume credits when a play runs. Start with one company-only row and leave automatic execution disabled.

1. Install the pinned dependencies with npm ci and run the local demo and checks.
2. Sign into Cargo yourself with cargo-ai login using the installed CLI, then confirm cargo-ai whoami selects the intended workspace. The local CLI is available through npx cargo-ai after npm ci.
3. Scaffold a separate project with the installed CLI: `npx cargo-ai project init /absolute/path/to/my-cargo-project`. Do not initialize over a populated project. Install that project's dependencies according to the scaffold.
4. From this compiler repository, run `npm run compile -- --schema samples/company-qualification.claymate.json --csv samples/companies.csv --name demo_companies --out /absolute/path/to/my-cargo-project`.
5. Review the generated migration report. Connect/bind the company and AI integrations in your Cargo workspace, and select a languageModel supported by your Anthropic connector. AI configuration is adapted, not an exact clone of Clay's GPT-4o settings.
6. In the Cargo project run `npx cargo-ai project check`, then `npx cargo-ai project plan`. Inspect the resource graph and credit implications. Deploy only the reviewed project with `npx cargo-ai project deploy`. It ships with its play disabled.
7. Find the newly created model ID using Cargo's model view or `npx cargo-ai storage model list`. Do not use a model or deployment ID from somebody else's demo.
8. Preview one row, using the generated script from that project:

```bash
node --import tsx scripts/clay-demo-companies/load-rows.ts \
  --csv /absolute/path/to/this-repository/samples/companies.csv \
  --limit 1
```

The scaffold must have tsx available for this generated script. It prints a dry run. To write the row, add `--model-uuid YOUR_MODEL_UUID --execute`. This importer creates rows and does not deduplicate; don't repeat a successful upload unnecessarily.

9. Wait until the row is visible in Cargo's stored model. Open the generated play, then Trigger → Enroll manually, and enroll only the test row. Keep the main schedule disabled. This uses credits.
10. Inspect the trace and read the saved values back from the model. Compare against a real Clay export before claiming parity. Different providers or models can legitimately return different outputs.

Cargo's command names, provider schemas and UI can change. Use the pinned CLI's --help and Cargo's official documentation if your installed version differs. Do not enable a schedule or enroll a full table until you have checked sample quality and costs.

The sample CSV has company websites only. Email finding is not part of this fixture. Do not use fictional identities for live personal enrichment.

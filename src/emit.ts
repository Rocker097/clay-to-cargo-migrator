// Writes the Cargo project files for a migration plan, laid out the way
// Cargo's own cookbooks are: infra/<name>/ for resources, scripts/<name>/
// for scripts the CDK loader never imports.

import { readFileSync } from "node:fs";
import { camel } from "./naming.ts";
import type { MigrationPlan, PlannedColumn } from "./plan.ts";

export interface GeneratedFile {
  path: string;
  content: string;
}

const zodFor = (t: string) =>
  t === "number" ? "z.number().optional()" : t === "boolean" ? "z.boolean().optional()" : "z.string().optional()";

const comment = (text: string, indent = "") =>
  text
    .split("\n")
    .map((l) => `${indent}// ${l}`.trimEnd())
    .join("\n");

export function emitProject(plan: MigrationPlan): GeneratedFile[] {
  const dir = `clay-${plan.name.replace(/_/g, "-")}`;
  const infra = `infra/${dir}`;
  const files: GeneratedFile[] = [];
  const gen = plan.columns.filter((c) => c.generated);
  let stored = gen.filter((c) => c.kind === "input" || c.kind === "loader-formula");
  const tools = gen.filter((c) => c.kind === "action" || c.kind === "ai");
  const agents = gen.filter((c) => c.kind === "ai");
  const bodyFormulas = gen.filter((c) => c.kind === "body-formula");
  const label = plan.name.replace(/_/g, " ");
  for (const tool of tools.filter(c=>c.reuse)) {
    const reuse = tool.reuse!;
    const cacheColumns = [{slug:reuse.flag,type:"boolean"},{slug:reuse.raw,type:"string"},...reuse.fields.map(f=>({slug:f.slug,type:f.type}))];
    stored = stored.concat(cacheColumns.map(c=>({clay:{index:-1,name:`Migration cache: ${c.slug}`,type:"internal"},slug:c.slug,kind:"reuse-cache",generated:true,notes:[],verify:[],cargoType:c.type as PlannedColumn["cargoType"],usedFields:new Map()})));
  }


  // --- folders --------------------------------------------------------------
  const kinds: [string, string][] = [
    ["model", "modelsFolder"],
    ["tool", "toolsFolder"],
    ["play", "playsFolder"],
    ...(agents.length ? ([["agent", "agentsFolder"]] as [string, string][]) : []),
  ];
  files.push({
    path: `${infra}/folders.ts`,
    content: `import { defineFolder } from "@cargo-ai/cdk";

// Everything this migration deploys is filed under folders named after the
// Clay table, so it is easy to see what came from the migration and to remove
// it as one unit. Folders are per resource kind.
${kinds
  .map(
    ([kind, v]) => `export const ${v} = defineFolder("clay_${plan.name}_${kind}s", {
  kind: "${kind}",
  name: "Clay: ${label}",
});`,
  )
  .join("\n\n")}
`,
  });

  // --- connectors -----------------------------------------------------------
  const connectors = new Map<string, { varName: string; slug: string; integration: string }>();
  for (const t of tools) if (t.mapping) connectors.set(t.mapping.connector.varName, t.mapping.connector);
  if (agents.length) connectors.set("anthropic", { varName: "anthropic", slug: "anthropic", integration: "anthropic" });
  files.push({
    path: `${infra}/connectors.ts`,
    content: `import { defineConnector } from "@cargo-ai/cdk";

// Bound, not created: \`default: true\` links the workspace's existing
// connector for each integration, so nothing here holds a credential.
// Connect each one once in the Cargo app before deploying.
${[...connectors.values()]
  .map(
    (c) => `export const ${c.varName} = defineConnector("${c.slug}", {
  integration: "${c.integration}",
  default: true,
});`,
  )
  .join("\n\n")}
`,
  });

  // --- model ----------------------------------------------------------------
  const additional = [
    ...tools.map((c) => ({
      slug: c.slug,
      type: "string",
      label: c.clay.name,
      description: c.kind === "ai" ? `Agent answer (JSON) for the Clay AI column "${c.clay.name}".` : `Raw result (JSON) of ${c.mapping!.connector.integration}.${c.mapping!.action}, from the Clay column "${c.clay.name}".`,
    })),
    ...bodyFormulas.map((c) => ({
      slug: c.slug,
      type: c.cargoType,
      label: c.clay.name,
      description: `Clay formula: ${c.clay.typeSettings?.formulaText ?? ""}`,
    })),
    { slug: "migrated_at", type: "date", label: "Migrated at", description: "When the migration play wrote this row. Blank means not run yet; the play's once-only key." },
  ];
  files.push({
    path: `${infra}/models/${plan.modelSlug.replace(/_/g, "-")}.ts`,
    content: `import { defineModel } from "@cargo-ai/cdk";

import { modelsFolder } from "../folders";

// The Clay table as a native Cargo model, so it deploys on a bare workspace
// with no CRM attached.
//
// \`config.columns\` are the values loaded from the Clay CSV (inputs, plus
// formulas over inputs that the loader computes). \`additionalColumns\` are
// what the play writes back: one column per migrated enrichment, AI or
// formula column, plus the \`migrated_at\` stamp.
export const ${plan.modelVar} = defineModel("${plan.modelSlug}", {
  name: "Clay: ${label}",
  kind: "native",
  extractSlug: "defineCustom",
  config: {
    columns: [
      { slug: "clay_row_id", type: "string" },
${stored.map((c) => `      { slug: "${c.slug}", type: "${c.cargoType}" }, // Clay: "${c.clay.name}"`).join("\n")}
    ],
  },
  additionalColumns: [
${additional
  .map(
    (a) => `    {
      kind: "custom",
      slug: "${a.slug}",
      type: "${a.type}",
      label: ${JSON.stringify(a.label)},
      description: ${JSON.stringify(a.description)},
    },`,
  )
  .join("\n")}
  ],
  folder: modelsFolder,
});
`,
  });

  // --- agents ---------------------------------------------------------------
  for (const c of agents) {
    files.push({
      path: `${infra}/agents/${c.slug.replace(/_/g, "-")}.ts`,
      content: `import { defineAgent } from "@cargo-ai/cdk";

import { anthropic } from "../connectors";
import { agentsFolder } from "../folders";

// Clay AI column "${c.clay.name}" (#${c.clay.index}). The prompt itself is
// passed in by the tool, with the row's values filled in, so this agent only
// fixes the answer's shape and keeps it from writing anywhere.
export const ${c.agentVar} = defineAgent("clay_${plan.name}_${c.slug}", {
  connector: anthropic,
  languageModel: "claude-sonnet-5", // PLACEHOLDER: a model your Anthropic connector exposes
  systemPrompt: [
    "You answer one question about one row of a go-to-market table.",
    "Use only the facts given in the prompt. If they are not enough to answer, say so in the answer rather than guessing.",
    "Return the answer only, in the exact JSON shape requested. You do not write to any model.",
  ].join(" "),
  output: {
    type: "jsonSchema",
    jsonSchema: {
      type: "object",
      properties: {
        answer: { type: "string", description: "The answer to the prompt." },
      },
      required: ["answer"],
      additionalProperties: false,
    },
  },
  maxSteps: 2,
  folder: agentsFolder,
});
`,
    });
  }

  // --- tools ----------------------------------------------------------------
  for (const c of tools) files.push(emitTool(plan, infra, c));

  // --- play -----------------------------------------------------------------
  files.push(emitPlay(plan, infra, stored, tools, bodyFormulas));

  // --- loader script --------------------------------------------------------
  files.push(emitLoader(plan, dir, stored));
  files.push({path:`scripts/${dir}/import-runtime.ts`,content:readFileSync(new URL("./import-runtime.ts",import.meta.url),"utf8")});

  return files;
}

function emitTool(plan: MigrationPlan, infra: string, c: PlannedColumn): GeneratedFile {
  const ts = c.clay.typeSettings ?? {};
  const params = [...(c.toolParams ?? []), ...(c.reuse ? [
    {name:"migrationReuse",zod:"z.boolean().optional()",from:"Explicit reuse of exported Clay values"},
    {name:"savedRaw",zod:"z.string().optional()",from:"Original/exported result"},
    ...c.reuse.fields.map(f=>({name:`saved_${f.field}`,zod:zodFor(f.type),from:`CSV ${f.csv}`})),
  ] : [])];
  const outputs = [...c.usedFields.entries()].filter(([f]) => f !== "raw");
  const head: string[] = [`Clay column "${c.clay.name}" (#${c.clay.index}), action \`${ts.actionKey}\`.`];
  if (c.mapping) head.push(`Cargo job: ${c.mapping.job} -> ${c.mapping.connector.integration}.${c.mapping.action} (${c.mapping.credits} credits per call).`);
  if (c.providerSwap) head.push(`Provider swap: Clay ran ${c.providerSwap.from}; Cargo runs ${c.providerSwap.to}.`);
  if (c.conditionSource)
    head.push(
      `Clay run condition: ${c.conditionSource}`,
      "When it is false the tool returns nothing and makes no paid call, the",
      "same as Clay skipping the cell. The play passes in every value it reads.",
    );
  head.push("No writes here: the play owns what gets stored, so the tool stays reusable.");

  const uses = c.kind === "ai" ? c.agentVar! : c.mapping!.connector.varName;
  const importLine =
    c.kind === "ai"
      ? `import { ${c.agentVar} } from "../agents/${c.slug.replace(/_/g, "-")}";`
      : `import { ${c.mapping!.connector.varName} } from "../connectors";`;

  const guard = c.toolCondition
    ? `    if (!${c.toolCondition}) {
      return {};
    }

`
    : "";

  const reuseGuard = c.reuse ? `    if (input.migrationReuse) {
      return { raw: input.savedRaw, ${c.reuse.fields.map(f=>`${f.field}: input.saved_${f.field}`).join(", ")} };
    }

` : "";
  let call: string;
  if (c.kind === "ai") {
    call = `    const result = uses.${c.agentVar}({
      prompt: \`${c.promptTemplate}\`,
    });

    return {
      raw: JSON.stringify(result.answer),
      answer: result.answer.answer,
    };`;
  } else {
    const args = (c.actionArgs ?? []).map((a) => {
      const value = `input.${a.param}`;
      // Clay company_identifier accepts a URL; Cargo's action expects a domain.
      const normalize = c.mapping?.id === "company-from-domain" && c.clay.typeSettings?.inputsBinding?.some(b => b.name === "company_identifier");
      const expr = normalize && a.cargoField === "domain"
        ? `(${value} ? ${value}.trim().toLowerCase().replace("https://", "").replace("http://", "").replace("www.", "").split("/")[0].split("?")[0].split("#")[0] : "")`
        : value;
      return `      ${a.cargoField}: ${expr},`;
    }).join("\n");
    call = `    const result = uses.${uses}.${c.mapping!.action}({
${args}
    });

    return {
      raw: JSON.stringify(result),
${outputs.map(([f]) => {
  const path = c.mapping!.outputPaths?.[f];
  if (!path) return `      ${f}: result.${f},`;
  let expression = `result.${path.join(".")}`;
  for (let i = path.length; i > 0; i--) {
    const prefix = `result.${path.slice(0, i).join(".")}`;
    expression = `(${prefix} ? ${expression} : "")`;
  }
  return `      ${f}: ${expression},`;
}).join("\n")}
    };`;
  }

  const outFields =
    c.kind === "ai"
      ? ["      raw: z.string().optional(),", "      answer: z.string().optional(),"]
      : ["      raw: z.string().optional(),", ...outputs.map(([f, t]) => `      ${f}: ${zodFor(t)},`)];

  return {
    path: `${infra}/tools/${c.slug.replace(/_/g, "-")}.ts`,
    content: `import { defineTool, defineWorkflow } from "@cargo-ai/cdk";
import { z } from "zod";

${importLine}
import { toolsFolder } from "../folders";

${comment(head.join("\n"))}
const workflow = defineWorkflow(
  "clay_${plan.name}_${c.slug}_workflow",
  {
    input: z.object({
${params.map((p) => `      ${p.name}: ${p.zod}, // ${p.from.replace(/\n/g, " ")}`).join("\n")}
    }),
    output: z.object({
${outFields.join("\n")}
    }),
    uses: { ${uses} },
  },
  ({ input, uses }) => {
${guard}${reuseGuard}${call}
  },
);

export const ${c.toolVar} = defineTool("clay_${plan.name}_${c.slug}", {
  folder: toolsFolder,
  workflow,
  name: ${JSON.stringify(c.clay.name)},
  description: ${JSON.stringify(
    c.kind === "ai"
      ? `Migrated from the Clay AI column "${c.clay.name}". Answers its prompt for one row.`
      : `Migrated from the Clay column "${c.clay.name}": ${c.mapping!.job.toLowerCase()}. Returns the raw result; writes nothing.`,
  )},
});
`,
  };
}

function emitPlay(
  plan: MigrationPlan,
  infra: string,
  stored: PlannedColumn[],
  tools: PlannedColumn[],
  bodyFormulas: PlannedColumn[],
): GeneratedFile {
  const playVar = camel(`migrate_clay_${plan.name}`);
  const steps = tools
    .map((c) => {
      const args = [(c.toolParams ?? []).map((p) => `      ${p.name}: ${p.playExpr},`).join("\n"),
        c.reuse ? `      migrationReuse: input.${c.reuse.flag},\n      savedRaw: input.${c.reuse.raw},\n${c.reuse.fields.map(f=>`      saved_${f.field}: input.${f.slug},`).join("\n")}` : ""].join("\n");
      return `    // #${c.clay.index} "${c.clay.name}"${c.conditionSource ? ` (runs only if: ${c.conditionSource})` : ""}
    const ${c.resultVar} = uses.${c.toolVar}({
${args}
    });`;
    })
    .join("\n\n");

  const mappings = [
    ...tools.map((c) => `        { columnSlug: "${c.slug}", value: (${c.resultVar}.raw ? ${c.resultVar}.raw : "") },`),
    ...bodyFormulas.map((c) => `        // Clay formula: ${c.clay.typeSettings?.formulaText ?? ""}\n        { columnSlug: "${c.slug}", value: (${c.bodyExpr} == null ? null : ${c.bodyExpr}) },`),
    `        { columnSlug: "migrated_at", value: new Date() },`,
  ];

  return {
    path: `${infra}/plays/migrate-clay-${plan.name.replace(/_/g, "-")}.ts`,
    content: `import { definePlay, defineWorkflow } from "@cargo-ai/cdk";
import { z } from "zod";

import { playsFolder } from "../folders";
import { ${plan.modelVar} } from "../models/${plan.modelSlug.replace(/_/g, "-")}";
${tools.map((c) => `import { ${c.toolVar} } from "../tools/${c.slug.replace(/_/g, "-")}";`).join("\n")}

// One Clay row in, every migrated column out, in the order Clay ran them.
// Each column is a tool; this body only passes values between them, so a
// Clay waterfall (rung 2 runs when rung 1 found nothing) is just rung 2's
// tool reading rung 1's result.
//
// Kept to straight calls, ternaries and one write, because Cargo parses this
// body from source: no \`?.\`, no \`??\`, no \`||\` fallbacks.
const migrateRow = defineWorkflow(
  "migrate_clay_${plan.name}_row",
  {
    input: z.object({
      id: z.string(),
      clay_row_id: z.string().optional(),
${stored.map((c) => `      ${c.slug}: ${zodFor(c.cargoType)},`).join("\n")}
    }),
    output: z.object({ status: z.literal("migrated") }),
    uses: { ${tools.map((c) => c.toolVar).join(", ")} },
    imports: { ${plan.modelVar} },
  },
  ({ input, uses, model }) => {
${steps}

    // One write per row, results and stamp together, so a row is never
    // marked migrated without carrying its results. Bare slugs: the write
    // path nests them under \`custom\` itself.
    model.customColumn({
      modelUuid: ${plan.modelVar}.uuid,
      id: input.id,
      mappings: [
${mappings.join("\n")}
      ],
    });

    return { status: "migrated" as const };
  },
);

// Runs each row once: rows with a blank \`migrated_at\` enter the filter, and
// \`changeKinds: ["added"]\` only creates runs for rows entering it, so the
// bill scales with new rows, not with how often the schedule fires.
//
// Ships disabled. Load a pilot (the loader defaults to 20 rows), run it,
// compare against Clay with the parity script, then enable.
export const ${playVar} = definePlay("migrate_clay_${plan.name}", {
  description: ${JSON.stringify(`Runs the migrated Clay table "${label(plan)}" on each new row and writes the results back.`)},
  folder: playsFolder,
  model: ${plan.modelVar},
  workflow: migrateRow,
  filter: {
    conjonction: "and",
    groups: [
      {
        conjonction: "and",
        conditions: [
          {
            kind: "date",
            columnSlug: ${plan.modelVar}.columns.custom__migrated_at,
            operator: "isNull",
          },
        ],
      },
    ],
  },
  isEnabled: false,
  runCreationRule: "noConcurrency",
  changeKinds: ["added"],
  schedule: { type: "cron", cron: "0 * * * *" },
});
`,
  };
}

const label = (plan: MigrationPlan) => plan.name.replace(/_/g, " ");

function emitLoader(plan: MigrationPlan, dir: string, stored: PlannedColumn[]): GeneratedFile {
  const inputs = stored.filter(c=>c.kind === "input").map(c=>({clay:c.clay.name,slug:c.slug,type:c.cargoType}));
  const formulas = stored.filter(c=>c.kind === "loader-formula");
  const reuse=plan.columns.flatMap(c=>c.reuse?[c.reuse]:[]);
  return {path:`scripts/${dir}/load-rows.ts`,content:`// Dry run by default. Use a stable --id-column and --source for resumable imports.
import {readFileSync} from "node:fs";
import {join} from "node:path";
import {prepareRows, importPrepared, domainOf, type Row} from "./import-runtime.ts";
const INPUTS=${JSON.stringify(inputs,null,2)};
const REUSE=${JSON.stringify(reuse,null,2)};
const FORMULAS=[
${formulas.map(c=>`  {slug:${JSON.stringify(c.slug)},compute:(row:Row)=>${c.loaderExpr}},`).join("\n")}
];
function arg(name:string){const i=process.argv.indexOf("--"+name);return i<0?undefined:process.argv[i+1];}
const csv=arg("csv");if(!csv)throw new Error("Provide --csv <path>");
const execute=process.argv.includes("--execute"),idColumn=arg("id-column");
if(execute&&!idColumn)throw new Error("Execution requires --id-column: row numbers are not stable IDs");
const source=arg("source")??${JSON.stringify(plan.modelSlug)};
const records=prepareRows(readFileSync(csv,"utf8"),INPUTS,FORMULAS,REUSE,{limit:Number(arg("limit")??20),source,idColumn,reuseExisting:process.argv.includes("--reuse-existing")});
console.log(JSON.stringify({rows:records.length,preview:records.slice(0,3)},null,2));
if(!execute){console.log("Dry run. No Cargo calls made.");process.exit(0);}
const model=arg("model-uuid");if(!model)throw new Error("Execution requires --model-uuid");
const checkpoint=arg("checkpoint")??join(".migration-checkpoints",model+".json");
const result=importPrepared(records,model,checkpoint);
console.log(JSON.stringify(result));
`};
}

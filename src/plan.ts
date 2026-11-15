// Turns a Clay schema into a migration plan: what each column becomes in
// Cargo, the code it compiles to, and why anything was not migrated.
//
// Clay columns compile like this:
//   text input            -> a column on a native Cargo model (loaded from CSV)
//   formula over inputs   -> computed by the loader at load time (e.g. DOMAIN)
//   enrichment action     -> one reusable Cargo tool wrapping the mapped action
//   AI / Claygent column  -> a Cargo agent, wrapped in a tool
//   formula over results  -> an expression in the play, written to the row
//   run condition         -> a guard inside the column's tool; the play passes
//                            the values the condition reads. A Clay waterfall
//                            (rung 2 runs only if rung 1 found nothing) is
//                            just this, so it needs no special case.
//   CRM write / source    -> not generated, reported (see reasons below)
//
// Export order is presentation order. Resolve dependencies before planning.

import { cargoColumnType, type ClayColumn, type ClaySchema } from "./claymate.ts";
import { emitBody, emitLoader, FormulaError, parseFormula, refsOf, type Node } from "./formula.ts";
import {
  ACTION_MAPPINGS,
  clayProviderOf,
  findMapping,
  isAiAction,
  isCrmWrite,
  findKnownJob,
  normalizeBindingName,
  type ActionMapping,
} from "./mappings.ts";
import { planReuse } from "./reuse.ts";
import { inferType } from "./types.ts";
import { camel, SlugRegistry } from "./naming.ts";

export type ColumnKind =
  | "reuse-cache"
  | "input"
  | "loader-formula"
  | "body-formula"
  | "action"
  | "ai"
  | "crm-write"
  | "source"
  | "known-unverified"
  | "unmapped";

export interface ToolParam {
  name: string;
  /** Expression the play passes for this parameter. */
  playExpr: string;
  zod: string;
  /** The Clay input or reference this came from, for comments. */
  from: string;
}

export interface PlannedColumn {
  reuse?: import("./import-runtime.ts").ReuseSpec;
  clay: ClayColumn;
  slug: string;
  kind: ColumnKind;
  generated: boolean;
  /** Why it was not generated, or notes about how it was. */
  notes: string[];
  verify: string[];
  cargoType: "string" | "number" | "boolean" | "date";
  // loader-formula
  loaderExpr?: string;
  expression?: Node;
  typeSource?: "export" | "inferred";
  // body-formula
  bodyExpr?: string;
  // action / ai
  mapping?: ActionMapping;
  providerSwap?: { from: string; to: string };
  toolVar?: string;
  resultVar?: string;
  toolParams?: ToolParam[];
  /** Cargo action call arguments inside the tool: cargoField -> tool param. */
  actionArgs?: { cargoField: string; param: string }[];
  /** Condition inside the tool, over tool params. */
  toolCondition?: string;
  conditionSource?: string;
  /** Output fields read downstream, Cargo name -> type. */
  usedFields: Map<string, "string" | "number" | "boolean">;
  // ai
  agentVar?: string;
  /** Scalar output fields declared by the Clay AI column's output schema. */
  aiOutputs?: AiOutputs;
  promptTemplate?: string;
}

export interface MigrationPlan {
  name: string;
  modelSlug: string;
  modelVar: string;
  columns: PlannedColumn[];
}

class Blocked extends Error {}

export interface MappingOverrides {
  /** Exact Clay action key to an existing verified mapping ID. */
  actions?: Record<string, string | { adapter: string; inputAliases?: Record<string,string>; outputAliases?: Record<string,string> }>;
}

export function planMigration(schema: ClaySchema, name: string, overrides: MappingOverrides = {}): MigrationPlan {
  const slugs = new SlugRegistry(["clay_row_id", "migrated_at", "migration_status"]);
  const byName = new Map<string, PlannedColumn>();
  const columns: PlannedColumn[] = [];

  for (const clay of dependencyOrder(schema.columns)) {
    const ts = clay.typeSettings ?? {};
    const col: PlannedColumn = {
      clay,
      slug: slugs.take(clay.name, 30),
      kind: "unmapped",
      generated: false,
      notes: [],
      verify: [],
      cargoType: cargoColumnType(ts.dataTypeSettings?.type ?? ts.formulaType ?? clay.type),
      usedFields: new Map(),
    };
    columns.push(col);
    byName.set(clay.name, col);

    try {
      if (clay.type === "source") {
        col.kind = "source";
        col.notes.push("Rows come in through the generated load-rows script (or a Cargo extractor) instead of a Clay source.");
      } else if (["text", "number", "boolean", "checkbox", "currency", "percent", "date", "datetime", "url", "email"].includes(clay.type)) {
        col.typeSource = "export";
        const declared = ts.dataTypeSettings?.type ?? clay.type;
        if (!["text","string","number","boolean","checkbox","currency","percent","date","datetime","url","email"].includes(declared.toLowerCase())) throw new Blocked(`Structured or unknown input type ${declared} is not supported`);
        col.kind = "input";
        col.generated = true;
      } else if (clay.type === "formula") {
        planFormula(col, byName);
      } else if (clay.type === "action") {
        planAction(col, byName, overrides);
      } else {
        col.notes.push(`Unknown Clay column type "${clay.type}".`);
      }
    } catch (err) {
      col.generated = false;
      if (err instanceof Blocked) col.notes.push(err.message);
      else if (err instanceof FormulaError) col.notes.push(`Formula not supported: ${err.message}.`);
      else throw err;
    }
  }

  const plan = { name, modelSlug: `clay_${name}`, modelVar: camel(`clay_${name}`), columns };
  planReuse(plan);
  return plan;
}

/** Stable dependency order; cycles and ambiguous names fail before generation. */
function dependencyOrder(columns: ClayColumn[]): ClayColumn[] {
  const byName = new Map(columns.map(c => [c.name, c]));
  if (byName.size !== columns.length) throw new Error("Duplicate column names are ambiguous.");
  const state = new Map<string, number>();
  const ordered: ClayColumn[] = [];
  function visit(c: ClayColumn) {
    if (state.get(c.name) === 2) return;
    if (state.get(c.name) === 1) throw new Error(`Dependency cycle involving "${c.name}".`);
    state.set(c.name, 1);
    const ts = c.typeSettings;
    const texts = [ts?.formulaText, ts?.conditionalRunFormulaText, ...(ts?.inputsBinding ?? []).map(b => b.formulaText)];
    for (const text of texts) for (const match of (text ?? "").matchAll(/\{\{@([^}]+)\}\}/g)) {
      const dep = byName.get(match[1].trim());
      if (dep) visit(dep);
    }
    state.set(c.name, 2);
    ordered.push(c);
  }
  columns.forEach(visit);
  return ordered;
}

// ---------------------------------------------------------------------------

function lookup(byName: Map<string, PlannedColumn>, name: string, forCol: PlannedColumn): PlannedColumn {
  const dep = byName.get(name);
  if (!dep) throw new Blocked(`References "${name}", which is absent from the table.`);
  if (!dep.generated) throw new Blocked(`Depends on "${name}", which was not migrated.`);
  void forCol;
  return dep;
}

export type AiOutputs = Record<string, "string" | "number" | "boolean">;

const AI_SCALAR: Record<string, "string" | "number" | "boolean"> = {
  string: "string", text: "string", str: "string",
  number: "number", integer: "number", int: "number", float: "number", decimal: "number",
  boolean: "boolean", bool: "boolean", checkbox: "boolean",
};

/**
 * Reads a Clay AI output contract. Accepts a full JSON Schema object
 * ({type:"object",properties:{score:{type:"number"}}}), Clay's shorthand
 * ({score:"number"}), a list of {name,type}, or a JSON string of any of
 * these. Only flat scalar fields are accepted; anything else is refused.
 * Returns undefined when the value is a format hint ("json", "text").
 */
export function parseAiOutputContract(value: unknown, label: string): AiOutputs | undefined {
  let v: unknown = value;
  if (typeof v === "string") {
    let text = v.trim();
    if (/^"(?:json|json_object|text)"$/i.test(text) || /^(?:json|json_object|text)$/i.test(text)) return undefined;
    if (/^".*"$/s.test(text)) {
      try { text = JSON.parse(text); } catch { /* keep as is */ }
    }
    try { v = JSON.parse(String(text)); } catch { throw new Blocked(`AI output contract ${label} is not readable JSON.`); }
  }
  if (typeof v !== "object" || v === null) throw new Blocked(`AI output contract ${label} has an unsupported shape.`);
  const out: AiOutputs = {};
  const add = (name: unknown, type: unknown) => {
    if (typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Blocked(`AI output field name ${JSON.stringify(name)} in ${label} is not a valid identifier.`);
    if (name === "raw") throw new Blocked(`AI output field "raw" in ${label} collides with the migrator's raw result column.`);
    const t = typeof type === "string" ? AI_SCALAR[type.toLowerCase()] : undefined;
    if (!t) throw new Blocked(`AI output field "${name}" in ${label} has type ${JSON.stringify(type)}; only string, number and boolean fields are supported.`);
    out[name] = t;
  };
  if (Array.isArray(v)) {
    for (const f of v) {
      if (!f || typeof f !== "object") throw new Blocked(`AI output contract ${label} has an unsupported field entry.`);
      add((f as any).name ?? (f as any).key, (f as any).type);
    }
  } else {
    const o = v as Record<string, unknown>;
    if (o.json_schema && typeof o.json_schema === "object") return parseAiOutputContract((o.json_schema as any).schema ?? o.json_schema, label);
    // OpenAI-style response_format objects ({type:"json_schema"}) name a
    // format, not fields. Without a schema attached there is nothing to carry.
    if (typeof o.type === "string" && /^(json_schema|json_object|json|text)$/i.test(o.type) && !o.properties && !o.schema) return undefined;
    if (o.schema && typeof o.schema === "object" && !o.properties) return parseAiOutputContract(o.schema, label);
    if (o.properties && typeof o.properties === "object") {
      if (o.type !== undefined && o.type !== "object") throw new Blocked(`AI output contract ${label} must describe an object.`);
      for (const [name, spec] of Object.entries(o.properties as Record<string, unknown>)) {
        add(name, spec && typeof spec === "object" ? (spec as any).type : spec);
      }
    } else {
      for (const [name, type] of Object.entries(o)) add(name, type);
    }
  }
  if (!Object.keys(out).length) throw new Blocked(`AI output contract ${label} declares no fields.`);
  return out;
}

/** Resolve a Clay field read off an action column to the Cargo field name. */
function outputField(dep: PlannedColumn, path: string[], from: PlannedColumn): string {
  if (path.length === 0) return dep.mapping?.primaryField ?? (dep.kind === "ai" ? (dep.aiOutputs ? "raw" : "answer") : "raw");
  const clayField = path.join(".");
  if (path.length > 1 && !Object.hasOwn(dep.mapping?.fieldSynonyms ?? {}, clayField)) throw new Blocked(`Nested output "${clayField}" needs an explicit verified adapter mapping.`);
  if (dep.kind === "ai") {
    if (dep.aiOutputs) {
      if (!Object.hasOwn(dep.aiOutputs, clayField)) throw new Blocked(`AI output field "${clayField}" is not declared in "${dep.clay.name}"'s output schema.`);
      return clayField;
    }
    if (clayField !== "answer") throw new Blocked(`AI output field "${clayField}" is not supported; only answer is available.`);
    return "answer";
  }
  const m = dep.mapping!;
  const cargoField = m.fieldSynonyms[clayField] ?? clayField;
  if (!(cargoField in m.knownOutputs) && cargoField !== m.primaryField) {
    throw new Blocked(`Unknown output field "${cargoField}" on "${dep.clay.name}". Add a verified adapter field mapping.`);
  }
  return cargoField;
}

/** Expression in the play for a Clay reference. */
function playRef(byName: Map<string, PlannedColumn>, from: PlannedColumn, name: string, path: string[]): string {
  const dep = lookup(byName, name, from);
  switch (dep.kind) {
    case "input":
    case "loader-formula":
      if (path.length) throw new Blocked(`Reads a property of "${name}", which is a plain value.`);
      return `input.${dep.slug}`;
    case "body-formula":
      if (path.length) throw new Blocked(`Reads a property of formula column "${name}".`);
      return dep.bodyExpr!;
    case "action":
    case "ai": {
      const field = outputField(dep, path, from);
      const type = dep.kind === "ai" ? (dep.aiOutputs?.[field] ?? "string") : (dep.mapping?.knownOutputs[field] ?? "string");
      dep.usedFields.set(field, type);
      return `${dep.resultVar}.${field}`;
    }
    default:
      throw new Blocked(`Depends on "${name}", which was not migrated.`);
  }
}

function planFormula(col: PlannedColumn, byName: Map<string, PlannedColumn>) {
  const text = col.clay.typeSettings?.formulaText ?? "";
  const ast = parseFormula(text);
  const deps = refsOf(ast).map((r) => lookup(byName, r.name, col));
  col.expression = ast;
  const inputOnly = deps.every((d) => d.kind === "input" || d.kind === "loader-formula");

  if (inputOnly) {
    // CSV inputs are scalar values, not arbitrary objects. Only a known
    // string property is supported; never silently discard an unknown path.
    for (const ref of refsOf(ast)) {
      if (ref.path.length && !(ref.path.length === 1 && ref.path[0] === "length" && byName.get(ref.name)!.cargoType === "string")) {
        throw new Blocked(`Unsupported input property "${ref.path.join(".")}" on "${ref.name}"; only string length is supported.`);
      }
    }
    // Computed once at load time. Runs as normal JavaScript, so functions a
    // Cargo workflow body cannot run (DOMAIN) are fine here.
    col.kind = "loader-formula";
    col.loaderExpr = emitLoader(ast, (n) => `row[${JSON.stringify(byName.get(n)!.slug)}]`);
    col.notes.push(`Computed by the loader at load time: \`${text}\``);
  } else {
    col.kind = "body-formula";
    col.bodyExpr = emitBody(ast, (n, p) => playRef(byName, col, n, p));
    col.notes.push(`Computed in the play after the columns it reads: \`${text}\``);
  }
  const inferred = inferType(ast, (name, path) => {
    const dep = lookup(byName, name, col);
    if (dep.kind === "action" || dep.kind === "ai") {
      const field = outputField(dep, path, col);
      if (dep.kind === "ai") return field === "raw" ? "string" : (dep.aiOutputs?.[field] ?? "string");
      const known = dep.mapping!.knownOutputs[field];
      if (!known) throw new Blocked(`Output type for ${name}.${field} is not verified`);
      return known;
    }
    if (path.length) {
      if (path.length === 1 && path[0] === "length" && dep.cargoType === "string") return "number";
      throw new Blocked(`Unknown scalar property ${name}.${path.join(".")}`);
    }
    return dep.cargoType;
  });
  if (inferred === "array" || inferred === "regex") throw new Blocked("Array/regex results must be converted to a scalar before storage");
  if (inferred === "null" || inferred === "undefined") throw new Blocked("Formula has no concrete result type");
  if (inferred !== col.cargoType) col.notes.push(`Corrected exported type ${col.cargoType} to inferred ${inferred}.`);
  col.cargoType = inferred;
  col.typeSource = "inferred";
  col.generated = true;
}

function planAction(col: PlannedColumn, byName: Map<string, PlannedColumn>, overrides: MappingOverrides) {
  const ts = col.clay.typeSettings ?? {};
  const actionKey = (ts.actionKey ?? "").toLowerCase();

  if (isCrmWrite(actionKey)) {
    col.kind = "crm-write";
    col.notes.push(
      "Writes to a CRM. Cargo treats this as a sync step, not an enrichment, so it is left out until parity passes. Add it with the CRM connector's `updateRecords` (see Cargo's crm-enrichment cookbook).",
    );
    return;
  }

  const ai = !overrides.actions?.[ts.actionKey ?? ""] && isAiAction(actionKey);
  const override = overrides.actions?.[ts.actionKey ?? ""];
  const adapterId = typeof override === "string" ? override : override?.adapter;
  const inputNames = (ts.inputsBinding ?? []).map((b) => normalizeBindingName(b.name));
  // Recipe jobs that keywords misclassify are checked first, unless the
  // user supplied an explicit mapping override.
  const knownFirst = !adapterId && !ai ? findKnownJob(actionKey, inputNames, true) : undefined;
  let mapping = adapterId ? ACTION_MAPPINGS.find(m => m.id === adapterId) : ai || knownFirst ? undefined : findMapping(actionKey, inputNames);
  if (override && !mapping) throw new Error(`Unknown mapping ID: ${adapterId}`);
  if (mapping && typeof override === "object") {
    mapping = { ...mapping,
      params: mapping.params.map(p => ({...p, clayAliases: override.inputAliases?.[p.cargoField] ? [normalizeBindingName(override.inputAliases[p.cargoField])] : p.clayAliases})),
      fieldSynonyms: {...mapping.fieldSynonyms, ...override.outputAliases},
    };
    col.verify.push("Explicit input/output aliases were supplied. Verify their semantic equivalence against the source provider.");
  }

  if (!ai && !mapping) {
    const known = knownFirst ?? findKnownJob(actionKey, inputNames, false);
    if (known) {
      col.kind = "known-unverified";
      col.notes.push(
        `${known.job}. Cargo equivalent: ${known.suggestion}. Not generated: its input signature was not confirmed in Cargo source.`,
      );
    } else {
      col.kind = "unmapped";
      col.notes.push(`No confident Cargo mapping for action \`${ts.actionKey}\`. Needs manual review.`);
    }
    return;
  }

  col.kind = ai ? "ai" : "action";
  col.mapping = mapping;
  col.toolVar = camel(col.slug);
  col.resultVar = camel(`r_${col.slug}`);
  col.toolParams = [];
  col.actionArgs = [];

  const bindings = ts.inputsBinding ?? [];
  const used = new Set<string>();

  if (mapping) {
    const provider = clayProviderOf(actionKey);
    if (!actionKey.includes(mapping.connector.integration.toLowerCase())) {
      col.providerSwap = { from: provider, to: `${mapping.connector.integration}.${mapping.action}` };
      col.notes.push(
        `Provider swap: Clay used \`${ts.actionKey}\`; Cargo runs \`${mapping.connector.integration}.${mapping.action}\` for this job (${mapping.job}).`,
      );
    }
    if (mapping.recipeNote) col.notes.push(mapping.recipeNote);
    for (const p of mapping.params) {
      const b = bindings.find((x) => !used.has(x.name) && p.clayAliases.includes(normalizeBindingName(x.name)));
      if (!b) {
        if (p.required) throw new Blocked(`Could not find a Clay input for \`${p.cargoField}\` (looked for: ${p.clayAliases.join(", ")}).`);
        continue;
      }
      used.add(b.name);
      const ast = parseFormula(b.formulaText ?? "");
      const expr = emitBody(ast, (n, path) => playRef(byName, col, n, path));
      col.toolParams.push({ name: p.cargoField, playExpr: expr, zod: "z.string().optional()", from: `Clay input "${b.name}": ${b.formulaText}` });
      col.actionArgs.push({ cargoField: p.cargoField, param: p.cargoField });
    }
    for (const b of bindings) {
      if (!used.has(b.name)) throw new Blocked(`Clay input "${b.name}" has no matching field on the Cargo action; refusing to drop configuration.`);
    }
  } else {
    // AI column: the prompt is text with {{@Column}} references in it.
    const configured = (value: unknown) => value !== undefined && value !== null && value !== "";
    const outputSetting = /responseformat|jsonschema|outputschema|structuredoutput|outputfields/;
    const normalizeSetting = (key: string) => key.toLowerCase().replace(/[^a-z0-9]/g, "");
    // Output contracts: a flat schema of scalar fields is carried into the
    // agent's output schema. Format hints ("json") alone are ignored only when
    // a schema is also present; anything unreadable is still refused.
    let contract: AiOutputs | undefined;
    let formatOnly: string | undefined;
    const takeContract = (label: string, value: unknown) => {
      const parsed = parseAiOutputContract(value, label);
      if (!parsed) { formatOnly = label; return; }
      if (contract) throw new Blocked(`AI column declares more than one output schema (${label}); needs manual review.`);
      contract = parsed;
    };
    for (const [key, value] of Object.entries(ts)) {
      if (outputSetting.test(normalizeSetting(key)) && configured(value)) { takeContract(key, value); continue; }
      if (/^(model|modelname|languagemodel|temperature|reasoninglevel|reasoningbudget)$/.test(normalizeSetting(key)) && configured(value)) col.verify.push(`Dropped Clay AI setting ${key}: ${JSON.stringify(value)}. Configure and verify the Cargo agent explicitly.`);
    }
    for (const binding of bindings) {
      const key = normalizeSetting(binding.name);
      if (!configured(binding.formulaText)) continue;
      if (outputSetting.test(key)) { takeContract(binding.name, binding.formulaText); continue; }
      if (/^(model|modelname|languagemodel|temperature|reasoninglevel|reasoningbudget)$/.test(key)) col.verify.push(`Dropped Clay AI setting ${binding.name}: ${binding.formulaText}. Configure and verify the Cargo agent explicitly.`);
    }
    if (formatOnly && !contract) throw new Blocked(`Unsupported AI output contract ${formatOnly}: a format is set without a field schema; refusing to replace it with answer-only text.`);
    if (contract) {
      col.aiOutputs = contract;
      col.notes.push(`Structured AI output carried over: ${Object.entries(contract).map(([k, t]) => `${k} (${t})`).join(", ")}.`);
    }
    const promptBinding = bindings.find((b) => /prompt|instruction|message/.test(normalizeBindingName(b.name)) && !outputSetting.test(normalizeSetting(b.name))) ?? bindings.find((b) => !outputSetting.test(normalizeSetting(b.name)));
    if (!promptBinding?.formulaText) throw new Blocked("AI column has no prompt to carry over.");
    col.agentVar = camel(`${col.slug}_agent`);
    const promptText = promptBinding.formulaText;
    if (/^\s*["']/.test(promptText)) {
      // Real Clay exports encode prompt concatenation as an expression.
      const ast = parseFormula(promptText.replace(/Clay\.formatForAIPrompt\s*\(/g, "CLAY_FORMAT("));
      for (const ref of refsOf(ast)) {
        const dep = lookup(byName, ref.name, col);
        if (ref.path.length || !["input", "loader-formula", "body-formula"].includes(dep.kind)) {
          throw new Blocked("AI prompt formatting of object results needs manual review.");
        }
      }
      const paramFor = new Map<string, string>();
      const expr = emitBody(ast, (name, path) => {
        const dep = lookup(byName, name, col);
        if (!paramFor.has(name)) {
          const param = camel(`ctx_${dep.slug}`);
          paramFor.set(name, param);
          col.toolParams!.push({ name: param, playExpr: playRef(byName, col, name, path), zod: "z.any().optional()", from: `prompt reads {{@${name}}}` });
        }
        return `input.${paramFor.get(name)}`;
      });
      col.promptTemplate = "${" + expr + "}";
    } else col.promptTemplate = compilePromptTemplate(promptText, col, byName);
    col.verify.push(
      `Agent for "${col.clay.name}" uses a placeholder \`languageModel\`. Set it to a model on the workspace's Anthropic connector (run \`npm run types\` to get the typed list).`,
    );
    col.verify.push("AI provider/model and output field shape are adapted, not preserved: configure them before asserting parity. Clay formatting support is limited to primitive values.");
    col.notes.push("Clay AI column becomes a Cargo agent with a JSON answer, wrapped in a tool. Prompt carried over with column references wired in.");
    // Claygent browses the web; the generated agent only sees the values the
    // play passes in. Cargo's recipe: check its prompt library first, whose
    // research prompts run on scraped website text.
    const browses = actionKey.includes("claygent") || /\b(browse|visit|search the web|go to|look up|website|web page|pricing page|find .* on)\b/i.test(promptText);
    if (browses) {
      col.verify.push(
        `"${col.clay.name}" looks like web research (Claygent-style). The generated agent cannot browse: it only sees the values passed in, so its answers will not match Clay's. Per Cargo's clay-to-cargo recipe, check cargo-gtm/references/prompt-library first (e.g. company-research prompts run on scraped \`website_text\`) and add a scraping step that feeds this agent.`,
      );
    }
  }

  // The run condition becomes a guard inside the tool. Every value it reads
  // is passed in by the play as a parameter.
  const condText = ts.conditionalRunFormulaText?.trim();
  if (condText) {
    const ast = parseFormula(condText);
    const paramFor = new Map<string, string>();
    col.toolCondition = emitBody(ast, (n, path) => {
      const key = `${n}|${path.join(".")}`;
      if (!paramFor.has(key)) {
        const dep = lookup(byName, n, col);
        const pname = camel(`when_${dep.slug}${path.length ? "_" + path.join("_") : ""}`);
        paramFor.set(key, pname);
        col.toolParams!.push({
          name: pname,
          playExpr: playRef(byName, col, n, path),
          zod: "z.any().optional()",
          from: `run condition reads {{@${n}}}${path.length ? "." + path.join(".") : ""}`,
        });
      }
      return `input.${paramFor.get(key)}`;
    });
    col.conditionSource = condText;
  }

  col.generated = true;
}

function compilePromptTemplate(text: string, col: PlannedColumn, byName: Map<string, PlannedColumn>): string {
  // Split literal text from {{@Column}} or {{@Column}}?.field references.
  const re = /\{\{@([^}]+)\}\}((?:\??\.[A-Za-z_][A-Za-z0-9_]*)*)/g;
  let out = "";
  let last = 0;
  const paramFor = new Map<string, string>();
  for (const m of text.matchAll(re)) {
    out += escapeTemplate(text.slice(last, m.index));
    const name = m[1].trim();
    const path = (m[2] ?? "").split(/\??\./).filter(Boolean);
    const key = `${name}|${path.join(".")}`;
    if (!paramFor.has(key)) {
      const dep = lookup(byName, name, col);
      const pname = camel(`ctx_${dep.slug}${path.length ? "_" + path.join("_") : ""}`);
      paramFor.set(key, pname);
      col.toolParams!.push({ name: pname, playExpr: playRef(byName, col, name, path), zod: "z.any().optional()", from: `prompt reads {{@${name}}}` });
    }
    out += "${input." + paramFor.get(key) + "}";
    last = m.index! + m[0].length;
  }
  out += escapeTemplate(text.slice(last));
  return out;
}

function escapeTemplate(s: string): string {
  return s.replace(/[`\\]/g, "\\$&").replace(/\$\{/g, "\\${");
}

export type { Node };

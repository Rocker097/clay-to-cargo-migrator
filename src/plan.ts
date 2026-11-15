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
  /** Clay's own system prompt, when it is plain text. */
  aiSystemPrompt?: string;
  /** Frozen: Clay's existing value is loaded from the CSV instead of re-run. */
  frozen?: boolean;
}

export interface MigrationPlan {
  name: string;
  modelSlug: string;
  modelVar: string;
  columns: PlannedColumn[];
}

class Blocked extends Error {}

/** A binding that reads a LinkedIn URL: "linkedin", or "LI URL"/"LI profile". */
const LINKEDIN_HINT = /linkedin|\bli[ _-]?(url|profile)\b/i;

export interface MappingOverrides {
  /**
   * CSV imports: a column that cannot be re-run in Cargo loads the value
   * Clay already computed from the CSV export, so the columns that read it
   * can still migrate. New rows will not compute it; the report says so.
   */
  freezeBlocked?: boolean;
  /** Exact Clay action key to an existing verified mapping ID. */
  actions?: Record<string, string | { adapter: string; inputAliases?: Record<string,string>; outputAliases?: Record<string,string> }>;
}

const SOURCE_STEP = /(?:\??\.[A-Za-z_][A-Za-z0-9_]*|(?:\?\.)?\[\s*(?:\d+|"[^"\\]*"|'[^'\\]*')\s*\])/y;

/**
 * CSV-only migration: a Clay source (imported list, Apify actor, RSS feed,
 * Mixrank search...) is replaced by the CSV. Each field the table reads off
 * the source, e.g. {{@Imported Companies}}.domain, becomes its own CSV input
 * column named "Imported Companies.domain". The formulas are rewritten to
 * read that column. A bare {{@Source}} (the whole object) is left alone and
 * stays blocked.
 */
export function expandSources(columns: ClayColumn[]): { columns: ClayColumn[]; virtual: Map<string, string> } {
  const sources = columns.filter(c => c.type === "source").map(c => c.name);
  const virtual = new Map<string, string>();
  if (!sources.length) return { columns, virtual };
  const taken = new Set(columns.map(c => c.name));
  const rewrite = (text: string | undefined): string | undefined => {
    if (!text) return text;
    let out = "";
    let i = 0;
    while (i < text.length) {
      const start = text.indexOf("{{@", i);
      if (start < 0) { out += text.slice(i); break; }
      const end = text.indexOf("}}", start);
      if (end < 0) { out += text.slice(i); break; }
      const ref = text.slice(start + 3, end).trim();
      out += text.slice(i, start);
      i = end + 2;
      if (!sources.includes(ref)) { out += text.slice(start, i); continue; }
      const path: string[] = [];
      let j = i;
      for (;;) {
        SOURCE_STEP.lastIndex = j;
        const m = SOURCE_STEP.exec(text);
        if (!m) break;
        // A trailing method call (.toLowerCase()) is not a field.
        if (/^\s*\(/.test(text.slice(SOURCE_STEP.lastIndex))) break;
        const step = m[0].replace(/^\?\.?|^\.|\]$/g, "").replace(/^\[\s*|\s*$/g, "");
        path.push(/^["']/.test(step) ? step.slice(1, -1) : step);
        j = SOURCE_STEP.lastIndex;
      }
      const field = `${ref}.${path.join(".")}`;
      if (!path.length || (taken.has(field) && !virtual.has(field))) { out += text.slice(start, i); continue; }
      virtual.set(field, ref);
      out += `{{@${field}}}`;
      i = j;
    }
    return out;
  };
  const rewritten = columns.map((c) => {
    const ts = c.typeSettings;
    if (!ts) return c;
    return { ...c, typeSettings: { ...ts,
      formulaText: rewrite(ts.formulaText),
      conditionalRunFormulaText: rewrite(ts.conditionalRunFormulaText),
      inputsBinding: ts.inputsBinding?.map(b => ({ ...b, formulaText: rewrite(b.formulaText) })),
    } };
  });
  let index = Math.max(-1, ...columns.map(c => c.index)) + 1;
  for (const field of virtual.keys()) rewritten.push({ index: index++, name: field, type: "text", typeSettings: { dataTypeSettings: { type: "text" } } });
  return { columns: rewritten, virtual };
}

// Side effects are never frozen: loading their old output would hide that
// the write no longer happens.
const SIDE_EFFECT = /write-to|send|create|update|upsert|push|delete|add-to|webhook/;

let planning: { columns: PlannedColumn[]; byName: Map<string, PlannedColumn>; slugs: SlugRegistry; virtual: Map<string, PlannedColumn> } | undefined;

function freezable(col: PlannedColumn): boolean {
  if (col.generated || col.kind === "crm-write" || col.kind === "source") return false;
  if (!["formula", "action"].includes(col.clay.type)) return false;
  return !SIDE_EFFECT.test((col.clay.typeSettings?.actionKey ?? "").toLowerCase());
}

function freeze(col: PlannedColumn) {
  const reason = col.notes.at(-1) ?? "not supported";
  Object.assign(col, { kind: "input", generated: true, frozen: true, typeSource: "export", cargoType: "string",
    mapping: undefined, providerSwap: undefined, aiOutputs: undefined, toolParams: undefined, actionArgs: undefined,
    toolCondition: undefined, bodyExpr: undefined, loaderExpr: undefined, expression: undefined, usedFields: new Map() });
  col.notes = [`Not re-runnable in Cargo (${reason.replace(/\.$/, "")}). Frozen: Clay's value loads from the CSV column "${col.clay.name}".`];
  col.verify = [`Frozen from the Clay export: rows imported from the CSV keep Clay's value for "${col.clay.name}"; new rows added in Cargo will not compute it. Map it to a Cargo action or rewrite it to make it live.`];
}

/**
 * A field read off a frozen column ({{@Enrich}}?.organization?.name) becomes
 * its own load-time column, parsed out of the JSON Clay exported.
 */
function frozenField(dep: PlannedColumn, path: string[], consumer: PlannedColumn): PlannedColumn {
  const ctx = planning!;
  const name = `${dep.clay.name} → ${path.join(".")}`;
  const cached = ctx.virtual.get(name);
  if (cached) return cached;
  const v: PlannedColumn = {
    clay: { index: consumer.clay.index, name, type: "formula" },
    slug: ctx.slugs.take(`${dep.slug} ${path.join(" ")}`, 30),
    kind: "loader-formula", generated: true, typeSource: "inferred", cargoType: "string",
    loaderExpr: `readPath(row[${JSON.stringify(dep.slug)}], ${JSON.stringify(path)})`,
    notes: [`Read from frozen column "${dep.clay.name}" at load time (path ${path.join(".")}). Loaded as text.`],
    verify: [`Needs the CSV cell for "${dep.clay.name}" to hold Clay's JSON result. If the export holds a display value instead, this field loads empty.`], usedFields: new Map(),
  };
  ctx.columns.splice(ctx.columns.indexOf(consumer), 0, v);
  ctx.byName.set(name, v);
  ctx.virtual.set(name, v);
  return v;
}

/** Replace path reads on frozen columns with their load-time field columns. */
function unfreezePaths(node: Node, byName: Map<string, PlannedColumn>, consumer: PlannedColumn): Node {
  const go = (n: Node): Node => unfreezePaths(n, byName, consumer);
  switch (node.k) {
    case "ref": {
      const dep = byName.get(node.name);
      return dep?.frozen && node.path.length ? { k: "ref", name: frozenField(dep, node.path, consumer).clay.name, path: [] } : node;
    }
    case "array": return { ...node, items: node.items.map(go) };
    case "index": return { ...node, receiver: go(node.receiver) };
    case "method": return { ...node, receiver: go(node.receiver), args: node.args.map(go) };
    case "call": return { ...node, args: node.args.map(go) };
    case "unary": return { ...node, arg: go(node.arg) };
    case "bin": return { ...node, l: go(node.l), r: go(node.r) };
    case "cond": return { ...node, test: go(node.test), a: go(node.a), b: go(node.b) };
    default: return node;
  }
}

export function planMigration(schema: ClaySchema, name: string, overrides: MappingOverrides = {}): MigrationPlan {
  const slugs = new SlugRegistry(["clay_row_id", "migrated_at", "migration_status"]);
  const byName = new Map<string, PlannedColumn>();
  const columns: PlannedColumn[] = [];
  const expanded = expandSources(schema.columns);
  const sourceFields = new Map<string, string[]>();
  for (const [field, source] of expanded.virtual) sourceFields.set(source, [...(sourceFields.get(source) ?? []), field.slice(source.length + 1)]);
  planning = { columns, byName, slugs, virtual: new Map() };

  for (const clay of dependencyOrder(expanded.columns)) {
    const ts = clay.typeSettings ?? {};
    const virtualFrom = expanded.virtual.get(clay.name);
    const col: PlannedColumn = {
      clay,
      // Source fields get short, readable slugs: src_company_name.
      slug: slugs.take(virtualFrom ? `src ${clay.name.slice(virtualFrom.length + 1)}` : clay.name, 30),
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
        const fields = sourceFields.get(clay.name);
        if (fields) {
          col.generated = true;
          col.verify.push(`Clay source replaced by the CSV. Fields read from it load as CSV columns: ${fields.map(f => `"${clay.name}.${f}"`).join(", ")}. Make sure the CSV has them (rename the exported headers if needed).`);
        }
      } else if (expanded.virtual.has(clay.name)) {
        col.kind = "input";
        col.typeSource = "export";
        col.generated = true;
        col.notes.push(`Field read from Clay source "${expanded.virtual.get(clay.name)}", loaded from the CSV column "${clay.name}".`);
        col.verify.push(`CSV must include a "${clay.name}" column (the source field, flattened). Its type is not in the export, so it loads as text.`);
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
    if (overrides.freezeBlocked && freezable(col)) freeze(col);
  }
  planning = undefined;

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
  // Clay field types that are text underneath.
  url: "string", email: "string", date: "string", select: "string",
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
      for (const [name, spec] of Object.entries(o)) add(name, spec && typeof spec === "object" && !Array.isArray(spec) ? (spec as any).type : spec);
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
    // Clay's use-ai column without a declared schema answers in `response`.
    if (clayField === "response") return "answer";
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
      if (path.length && dep.frozen) return `input.${frozenField(dep, path, from).slug}`;
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
  const ast = unfreezePaths(parseFormula(text), byName, col);
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
  // Clay's company_identifier takes a domain or a LinkedIn company URL. A
  // LinkedIn URL normalized to a domain becomes "linkedin.com", so when the
  // binding plainly reads a LinkedIn URL, use the LinkedIn-URL action.
  if (!adapterId && mapping?.id === "company-from-domain") {
    const identifier = (ts.inputsBinding ?? []).find(b => normalizeBindingName(b.name) === "company_identifier");
    if (identifier && LINKEDIN_HINT.test(identifier.formulaText ?? "")) mapping = ACTION_MAPPINGS.find(m => m.id === "company-from-linkedin");
  }
  // Mixrank's person_identifier may be an email or a LinkedIn URL. Only a
  // binding that plainly reads a LinkedIn URL goes to enrichProfile.
  if (!adapterId && mapping?.id === "person-from-linkedin") {
    const identifier = (ts.inputsBinding ?? []).find(b => normalizeBindingName(b.name) === "person_identifier");
    if (identifier && !LINKEDIN_HINT.test(identifier.formulaText ?? "")) mapping = undefined;
  }
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
    const usedFormulas = new Set(bindings.filter(b => used.has(b.name)).map(b => (b.formulaText ?? "").trim()));
    const dropped: string[] = [];
    for (const b of bindings) {
      if (used.has(b.name)) continue;
      const formula = (b.formulaText ?? "").trim();
      // Clay fans one value out under many alias names (name, fullName,
      // full_name...). A copy of a value already passed loses nothing.
      if (formula && usedFormulas.has(formula)) continue;
      if (mapping.droppedSettings?.includes(normalizeBindingName(b.name))) {
        if (formula) dropped.push(`${b.name}: ${formula}`);
        continue;
      }
      if (!formula) continue;
      throw new Blocked(`Clay input "${b.name}" has no matching field on the Cargo action; refusing to drop configuration.`);
    }
    if (dropped.length) col.verify.push(`Clay settings with no ${mapping.connector.integration}.${mapping.action} equivalent were dropped: ${dropped.join("; ")}.`);
  } else {
    // AI column: the prompt is text with {{@Column}} references in it.
    const configured = (value: unknown) => value !== undefined && value !== null && value !== "";
    const outputSetting = /responseformat|jsonschema|outputschema|answerschema|structuredoutput|outputfields/;
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
    const unquote = (v: unknown) => {
      if (typeof v !== "string") return v;
      const t = v.trim();
      if (/^".*"$/s.test(t)) { try { return JSON.parse(t); } catch { return t; } }
      return t;
    };
    for (const binding of bindings) {
      const key = normalizeSetting(binding.name);
      if (binding.formulaMap && typeof binding.formulaMap === "object" && Object.keys(binding.formulaMap).length) {
        if (!outputSetting.test(key)) throw new Blocked(`AI setting "${binding.name}" is a structured value the migrator does not understand; needs manual review.`);
        // Clay's answerSchemaType: {type:"json", fields:{...}} or
        // {type:"json", jsonType:"JSONSchema", jsonSchema:"..."}, each value
        // a formula string.
        const map = binding.formulaMap as Record<string, unknown>;
        const type = String(unquote(map.type) ?? "").toLowerCase();
        if (map.fields !== undefined && map.fields !== "") takeContract(`${binding.name}.fields`, unquote(map.fields));
        else if (map.jsonSchema !== undefined && map.jsonSchema !== "") takeContract(`${binding.name}.jsonSchema`, unquote(map.jsonSchema));
        else if (type && type !== "text") formatOnly = `${binding.name} (${type})`;
        continue;
      }
      if (!configured(binding.formulaText)) continue;
      if (key === "systemprompt") {
        const ast = parseFormula(binding.formulaText!);
        if (ast.k !== "str") throw new Blocked("AI system prompt reads column values; needs manual review.");
        col.aiSystemPrompt = ast.v;
        continue;
      }
      if (outputSetting.test(key)) { takeContract(binding.name, binding.formulaText); continue; }
      if (/^(model|modelname|languagemodel|temperature|reasoninglevel|reasoningbudget)$/.test(key)) col.verify.push(`Dropped Clay AI setting ${binding.name}: ${binding.formulaText}. Configure and verify the Cargo agent explicitly.`);
    }
    if (formatOnly && !contract) throw new Blocked(`Unsupported AI output contract ${formatOnly}: a format is set without a field schema; refusing to replace it with answer-only text.`);
    if (contract) {
      col.aiOutputs = contract;
      col.notes.push(`Structured AI output carried over: ${Object.entries(contract).map(([k, t]) => `${k} (${t})`).join(", ")}.`);
    }
    const promptBinding = bindings.find((b) => normalizeSetting(b.name) === "prompt") ?? bindings.find((b) => normalizeSetting(b.name) !== "systemprompt" && /prompt|instruction|message/.test(normalizeBindingName(b.name)) && !outputSetting.test(normalizeSetting(b.name))) ?? bindings.find((b) => !outputSetting.test(normalizeSetting(b.name)));
    if (!promptBinding?.formulaText) throw new Blocked("AI column has no prompt to carry over.");
    col.agentVar = camel(`${col.slug}_agent`);
    const promptText = promptBinding.formulaText;
    if (/^\s*["']/.test(promptText)) {
      // Real Clay exports encode prompt concatenation as an expression.
      const ast = parseFormula(promptText.replace(/Clay\.formatForAIPrompt\s*\(/g, "CLAY_FORMAT("));
      for (const ref of refsOf(ast)) {
        const dep = lookup(byName, ref.name, col);
        // A scalar field of an enrichment or AI result ({{@Enrich}}.description)
        // is plain text in a prompt. A whole result object is not: Clay
        // formats it in its own way, so that still needs review.
        const scalarResult = ref.path.length
          ? (dep.kind === "action" || dep.kind === "ai") && outputField(dep, ref.path, col) !== "raw"
          : dep.kind === "ai" && !dep.aiOutputs; // a plain AI answer is text
        if ((ref.path.length && !dep.frozen && !scalarResult) || !(["input", "loader-formula", "body-formula"].includes(dep.kind) || scalarResult)) {
          throw new Blocked("AI prompt formatting of object results needs manual review.");
        }
      }
      const paramFor = new Map<string, string>();
      const expr = emitBody(ast, (name, path) => {
        const dep = lookup(byName, name, col);
        const key = `${name}|${path.join(".")}`;
        if (!paramFor.has(key)) {
          const param = camel(`ctx_${dep.slug}${path.length ? "_" + path.join("_") : ""}`);
          paramFor.set(key, param);
          col.toolParams!.push({ name: param, playExpr: playRef(byName, col, name, path), zod: "z.any().optional()", from: `prompt reads {{@${name}}}${path.length ? "." + path.join(".") : ""}` });
        }
        return `input.${paramFor.get(key)}`;
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

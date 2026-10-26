// The input format: a Clay table schema as exported by ClayMate Lite
// (https://github.com/GTM-Base/claymate-lite). This is the configuration
// export Cargo's own clay-to-cargo recipe asks for first ("path A"): it keeps
// which provider ran, with which inputs, under which run condition, none of
// which survives a CSV export.

export interface ClayInputBinding {
  name: string;
  formulaText?: string;
}

export interface ClayColumn {
  index: number;
  name: string;
  type: "text" | "formula" | "action" | "source" | string;
  typeSettings?: {
    dataTypeSettings?: { type?: string };
    formulaText?: string;
    formulaType?: string;
    actionKey?: string;
    actionPackageId?: string;
    actionVersion?: number;
    inputsBinding?: ClayInputBinding[];
    conditionalRunFormulaText?: string;
    authAccountId?: string;
    [k: string]: unknown;
  };
  sourceDetails?: { name: string; type: string }[];
}

export interface ClaySchema {
  version: string;
  exportedAt?: string;
  columnCount?: number;
  columns: ClayColumn[];
}

export function parseClaySchema(json: string): ClaySchema {
  const data = JSON.parse(json) as ClaySchema;
  if (!data || !Array.isArray(data.columns)) {
    throw new Error("Not a ClayMate schema: expected an object with a `columns` array.");
  }
  for (const [position, c] of data.columns.entries()) {
    if (!c || typeof c !== "object") throw new Error(`Invalid column at position ${position}.`);
    if (c.index === undefined) c.index = position;
    if (!Number.isFinite(c.index)) throw new Error(`Invalid index at position ${position}.`);
    if (c.typeSettings !== undefined && (!c.typeSettings || typeof c.typeSettings !== "object" || Array.isArray(c.typeSettings))) throw new Error(`Invalid settings on ${c.name}`);
    const ts=c.typeSettings;
    if(ts?.dataTypeSettings!==undefined&&(!ts.dataTypeSettings||typeof ts.dataTypeSettings!=="object"||(ts.dataTypeSettings.type!==undefined&&typeof ts.dataTypeSettings.type!=="string")))throw new Error(`Invalid data type settings on ${c.name}`);
    if (ts?.inputsBinding !== undefined && (!Array.isArray(ts.inputsBinding) || ts.inputsBinding.some(b=>!b||typeof b.name!=="string"||!b.name||(b.formulaText!==undefined&&typeof b.formulaText!=="string")))) throw new Error(`Invalid input bindings on ${c.name}`);
    for(const key of ["formulaText","conditionalRunFormulaText","actionKey"] as const) if(ts?.[key]!==undefined&&typeof ts[key]!=="string")throw new Error(`Invalid ${key} on ${c.name}`);
    if (typeof c.name !== "string" || !c.name.trim() || typeof c.type !== "string") {
      throw new Error(`Column at index ${c.index} is missing a name or type.`);
    }
  }
  return { ...data, columns: [...data.columns].sort((a, b) => a.index - b.index) };
}

/** Cargo column type for a Clay data type. */
export function cargoColumnType(clayType: string | undefined): "string" | "number" | "boolean" | "date" {
  switch ((clayType ?? "text").toLowerCase()) {
    case "number":
    case "currency":
    case "percent":
      return "number";
    case "boolean":
    case "checkbox":
      return "boolean";
    case "date":
    case "datetime":
      return "date";
    default:
      return "string";
  }
}

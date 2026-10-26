// Clay formulas and run conditions, parsed into an AST and emitted two ways:
//
//   emitBody   -> an expression for a Cargo workflow body. Cargo parses these
//                 bodies from source instead of running them, and its own
//                 cookbooks warn that `?.`, `??` and `||` fallbacks fail at
//                 runtime. So this emitter never produces those: `||` becomes
//                 a ternary, optional chaining becomes a plain member access.
//   emitLoader -> plain JavaScript for the row loader script, which does run
//                 normally, so anything goes (used for input-only formulas
//                 such as DOMAIN()).
//
// Only a deliberate subset of Clay's formula language is supported. Anything
// else throws FormulaError, and the column is reported as "needs manual
// review" instead of being guessed at.

export class FormulaError extends Error {}

export type Node =
  | { k: "array"; items: Node[] }
  | { k: "index"; receiver: Node; index: number; optional: boolean }
  | { k: "regex"; pattern: string; flags: string }
  | { k: "ref"; name: string; path: string[]; optionalPath?: boolean[] }
  | { k: "method"; receiver: Node; method: string; optional: boolean; args: Node[] }
  | { k: "nullish"; v: "null" | "undefined" }
  | { k: "str"; v: string }
  | { k: "num"; v: number }
  | { k: "bool"; v: boolean }
  | { k: "call"; fn: string; args: Node[] }
  | { k: "unary"; op: "!" | "-"; arg: Node }
  | { k: "bin"; op: string; l: Node; r: Node }
  | { k: "cond"; test: Node; a: Node; b: Node };

type Tok =
  | { t: "regex"; v: string; flags: string }
  | { t: "ref"; v: string }
  | { t: "str"; v: string }
  | { t: "num"; v: number }
  | { t: "id"; v: string }
  | { t: "op"; v: string };

const OPS = ["===", "!==", "?.", "??", "&&", "||", "==", "!=", ">=", "<=", ">", "<", "!", "+", "-", "*", "/", "(", ")", "[", "]", ",", ".", "?", ":"];

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (src.startsWith("{{", i)) {
      const end = src.indexOf("}}", i);
      if (end < 0) throw new FormulaError("Unclosed {{ reference");
      const inner = src.slice(i + 2, end).trim();
      if (!inner.startsWith("@")) throw new FormulaError(`Unsupported reference {{${inner}}}`);
      const name = inner.slice(1);
      if (name.startsWith("source:")) throw new FormulaError(`Source references are not supported: {{${inner}}}`);
      out.push({ t: "ref", v: name });
      i = end + 2;
      continue;
    }
    if (ch === "/" && (!out.length || (out.at(-1)!.t === "op" && ["(",",","["].includes(String(out.at(-1)!.v))))) {
      const match = /^\/((?:\\.|[^/\n])+)\/([a-z]*)/.exec(src.slice(i));
      if (!match) throw new FormulaError("Invalid regex literal");
      // Deliberately bounded cleanup patterns: no arbitrary regex/backtracking.
      if (!["[^0-9]", "[^a-zA-Z0-9]", "\\s+"].includes(match[1]) || !["", "g"].includes(match[2])) throw new FormulaError("Regex pattern/flags need explicit support");
      out.push({t:"regex",v:match[1],flags:match[2]});i+=match[0].length;continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      let v = "";
      while (j < src.length && src[j] !== ch) {
        if (src[j] === "\\" && j + 1 < src.length) {
          v += src[j + 1];
          j += 2;
        } else v += src[j++];
      }
      if (j >= src.length) throw new FormulaError("Unclosed string literal");
      out.push({ t: "str", v });
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      const m = /^[0-9]+(\.[0-9]+)?/.exec(src.slice(i))!;
      out.push({ t: "num", v: Number(m[0]) });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!;
      out.push({ t: "id", v: m[0] });
      i += m[0].length;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) throw new FormulaError(`Unexpected character "${ch}"`);
    out.push({ t: "op", v: op });
    i += op.length;
  }
  return out;
}

const PREC: Record<string, number> = {
  "??": 1, "||": 1, "&&": 2, "==": 3, "!=": 3, "===": 3, "!==": 3,
  ">": 4, "<": 4, ">=": 4, "<=": 4, "+": 5, "-": 5, "*": 6, "/": 6,
};

export function parseFormula(src: string): Node {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const isOp = (v: string) => peek()?.t === "op" && peek()!.v === v;
  const expectOp = (v: string) => {
    if (!isOp(v)) throw new FormulaError(`Expected "${v}"`);
    p++;
  };

  function primary(): Node {
    const tok = toks[p++];
    if (!tok) throw new FormulaError("Unexpected end of formula");
    let node: Node;
    if (tok.t === "regex") node = {k:"regex",pattern:tok.v,flags:tok.flags};
    else if (tok.t === "ref") node = { k: "ref", name: tok.v, path: [] };
    else if (tok.t === "str") node = { k: "str", v: tok.v };
    else if (tok.t === "num") node = { k: "num", v: tok.v };
    else if (tok.t === "id") {
      if (tok.v === "new" || tok.v === "Math" || tok.v === "Date") {
        let fn: string;
        if(tok.v === "new") {if(toks[p++]?.v !== "Date") throw new FormulaError("Only new Date(value) is supported");fn="DATE_VALUE";}
        else {expectOp("."); const member=toks[p++]?.v;fn=tok.v+"_"+member;if(!["Math_floor","Math_ceil","Math_round","Date_now"].includes(fn))throw new FormulaError("Unsupported standard function");}
        expectOp("(");const args:Node[]=[];if(!isOp(")")){args.push(expr(0));while(isOp(",")){p++;args.push(expr(0));}}expectOp(")");
        node={k:"call",fn,args};
      }
      else if (tok.v === "null" || tok.v === "undefined") node = { k: "nullish", v: tok.v };
      else if (tok.v === "true" || tok.v === "false") node = { k: "bool", v: tok.v === "true" };
      else if (isOp("(")) {
        p++;
        const args: Node[] = [];
        if (!isOp(")")) {
          args.push(expr(0));
          while (isOp(",")) {
            p++;
            args.push(expr(0));
          }
        }
        expectOp(")");
        node = { k: "call", fn: tok.v.toUpperCase(), args };
      } else throw new FormulaError(`Unknown identifier "${tok.v}"`);
    } else if (tok.v === "[") {
      const items:Node[]=[];if(!isOp("]")){items.push(expr(0));while(isOp(",")){p++;items.push(expr(0));}}expectOp("]");node={k:"array",items};
    } else if (tok.v === "(") {
      node = expr(0);
      expectOp(")");
    } else if (tok.v === "!" || tok.v === "-") {
      return { k: "unary", op: tok.v, arg: primary() };
    } else throw new FormulaError(`Unexpected "${tok.v}"`);

    // Keep optional access in the AST; dropping it changes missing-value behavior.
    while (isOp(".") || isOp("?.") || isOp("[")) {
      if(isOp("[") || (isOp("?.") && toks[p+1]?.v === "[")) {
        const optional=isOp("?.");if(optional)p++;p++;
        const index=toks[p++];if(index?.t!=="num"||!Number.isSafeInteger(index.v)||index.v<0)throw new FormulaError("Index must be a nonnegative integer literal");
        expectOp("]");node={k:"index",receiver:node,index:index.v,optional};continue;
      }
      const optional = isOp("?.");
      p++;
      const prop = toks[p++];
      if (!prop || prop.t !== "id") throw new FormulaError("Expected a property name after '.'");
      if (isOp("(")) {
        p++;
        const args: Node[] = [];
        if (!isOp(")")) {
          args.push(expr(0));
          while (isOp(",")) { p++; args.push(expr(0)); }
        }
        expectOp(")");
        if (!["toUpperCase", "toLowerCase", "trim", "includes", "startsWith", "endsWith", "replace", "replaceAll", "slice", "substring", "split", "join"].includes(prop.v)) {
          throw new FormulaError(`Method ${prop.v}() is not supported`);
        }
        const counts: Record<string, number[]> = {toUpperCase:[0],toLowerCase:[0],trim:[0],includes:[1],startsWith:[1],endsWith:[1],replace:[2],replaceAll:[2],slice:[1,2],substring:[1,2],split:[1],join:[0,1]};
        if (!counts[prop.v].includes(args.length)) throw new FormulaError(`${prop.v}() expects ${counts[prop.v].join(" or ")} arguments`);
        node = { k: "method", receiver: node, method: prop.v, optional, args };
        continue;
      }
      if (node.k !== "ref") throw new FormulaError("Property access is only supported on a column reference");
      node = { ...node, path: [...node.path, prop.v], optionalPath: [...(node.optionalPath ?? []), optional] };
    }
    return node;
  }

  function expr(minPrec: number): Node {
    let left = primary();
    for (;;) {
      const tok = peek();
      if (tok?.t === "op" && tok.v === "?" && minPrec === 0) {
        p++;
        const a = expr(0);
        expectOp(":");
        const b = expr(0);
        left = { k: "cond", test: left, a, b };
        continue;
      }
      if (tok?.t !== "op" || PREC[tok.v] === undefined || PREC[tok.v] < minPrec) break;
      p++;
      const right = expr(PREC[tok.v] + 1);
      left = { k: "bin", op: tok.v, l: left, r: right };
    }
    return left;
  }

  const node = expr(0);
  if (p !== toks.length) throw new FormulaError(`Unexpected "${(toks[p] as { v: unknown }).v}" after expression`);
  return node;
}

/** Every column reference in a formula, with the property path read off it. */
export function refsOf(node: Node): { name: string; path: string[] }[] {
  switch (node.k) {
    case "array": return node.items.flatMap(refsOf);
    case "index": return refsOf(node.receiver);
    case "ref":
      return [{ name: node.name, path: node.path }];
    case "method":
      return [...refsOf(node.receiver), ...node.args.flatMap(refsOf)];
    case "call":
      return node.args.flatMap(refsOf);
    case "unary":
      return refsOf(node.arg);
    case "bin":
      return [...refsOf(node.l), ...refsOf(node.r)];
    case "cond":
      return [...refsOf(node.test), ...refsOf(node.a), ...refsOf(node.b)];
    default:
      return [];
  }
}

export type RefResolver = (name: string, path: string[]) => string;

/** Expression for a Cargo workflow body: no `?.`, no `??`, no `||`. */
export function emitBody(node: Node, resolve: RefResolver): string {
  const e = (n: Node): string => emitBody(n, resolve);
  switch (node.k) {
    case "array": case "index": case "regex":
      throw new FormulaError("Array/index/regex syntax is supported only in input/loader formulas");
    case "method":
      throw new FormulaError(`${node.method}() method syntax is supported only in input/loader formulas; Cargo workflow translation needs separate verification`);
    case "ref":
      return resolve(node.name, node.path);
    case "nullish":
      return node.v;
    case "str":
      return JSON.stringify(node.v);
    case "num":
      return String(node.v);
    case "bool":
      return String(node.v);
    case "unary":
      return `${node.op}(${e(node.arg)})`;
    case "cond":
      return `(${e(node.test)} ? ${e(node.a)} : ${e(node.b)})`;
    case "bin": {
      const l = e(node.l);
      const r = e(node.r);
      if (node.op === "??") return `(${l} == null ? ${r} : ${l})`;
      if (node.op === "||") return `(${l} ? ${l} : ${r})`;
      const op = node.op === "==" ? "===" : node.op === "!=" ? "!==" : node.op;
      return `(${l} ${op} ${r})`;
    }
    case "call": {
      const a = node.args.map(e);
      switch (node.fn) {
        case "DATE_VALUE": case "Date_now": case "Math_floor": case "Math_ceil": case "Math_round":
          throw new FormulaError("Date/Math operations are supported only in input/loader formulas");
        case "CLAY_FORMAT":
          if (a.length !== 1) throw new FormulaError("Clay.formatForAIPrompt needs one argument");
          return `(${a[0]} == null ? "" : ${a[0]})`;
        case "COALESCE":
          if (!a.length) throw new FormulaError("COALESCE needs arguments");
          return a.slice(0, -1).reduceRight((acc, x) => `(${x} == null ? ${acc} : ${x})`, a[a.length - 1]);
        case "IF":
          if (a.length !== 3) throw new FormulaError("IF needs three arguments");
          return `(${a[0]} ? ${a[1]} : ${a[2]})`;
        case "CONCATENATE":
        case "CONCAT":
          return "`" + node.args.map((n, i) => (n.k === "str" ? n.v.replace(/[`\\$]/g, "\\$&") : "${" + a[i] + "}")).join("") + "`";
        case "LOWER":
          return `(${a[0]} ? ${a[0]}.toLowerCase() : "")`;
        case "UPPER":
          return `(${a[0]} ? ${a[0]}.toUpperCase() : "")`;
        case "TRIM":
          return `(${a[0]} ? ${a[0]}.trim() : "")`;
        case "CONTAINS":
          return `(${a[0]} ? ${a[0]}.includes(${a[1]}) : false)`;
        case "LEN":
          return `(${a[0]} ? ${a[0]}.length : 0)`;
        default:
          throw new FormulaError(`${node.fn}() is not supported inside a Cargo workflow`);
      }
    }
  }
}

/** Plain JavaScript for the loader script, evaluated over one CSV row. */
export function emitLoader(node: Node, resolve: RefResolver): string {
  const e = (n: Node): string => emitLoader(n, resolve);
  switch (node.k) {
    case "array": return `[${node.items.map(e).join(", ")}]`;
    case "regex": return `/${node.pattern}/${node.flags}`;
    case "index": return `${node.receiver.k === "method" || node.receiver.k === "index" || node.receiver.k === "ref" ? e(node.receiver) : "("+e(node.receiver)+")"}${node.optional?"?.":""}[${node.index}]`;
    case "ref":
      return node.path.reduce((value, property, index) =>
        `${value}${node.optionalPath?.[index] ? "?." : ""}[${JSON.stringify(property)}]`,
        resolve(node.name, []));
    case "method":
      // Do not parenthesize a method chain: (x?.trim()).toUpperCase()
      // would lose JavaScript's optional-chain short-circuit behavior.
      return `${node.receiver.k === "ref" || node.receiver.k === "method" || node.receiver.k === "index" ? e(node.receiver) : "(" + e(node.receiver) + ")"}${node.optional ? "?." : "."}${node.method}(${node.args.map(e).join(", ")})`;
    case "nullish":
      return node.v;
    case "str":
      return JSON.stringify(node.v);
    case "num":
    case "bool":
      return String(node.v);
    case "unary":
      return `${node.op}(${e(node.arg)})`;
    case "cond":
      return `(${e(node.test)} ? ${e(node.a)} : ${e(node.b)})`;
    case "bin": {
      const op = node.op === "==" ? "===" : node.op === "!=" ? "!==" : node.op;
      return `(${e(node.l)} ${op} ${e(node.r)})`;
    }
    case "call": {
      const a = node.args.map(e);
      switch (node.fn) {
        case "DATE_VALUE": return `new Date(${a[0]})`;
        case "Date_now": return "Date.now()";
        case "Math_floor": case "Math_ceil": case "Math_round": return `Math.${node.fn.slice(5)}(${a[0]})`;
        case "DOMAIN":
          return `domainOf(${a[0]})`;
        case "COALESCE":
          if (!a.length) throw new FormulaError("COALESCE needs arguments");
          return `(${a.join(" ?? ")})`;
        case "IF":
          return `(${a[0]} ? ${a[1]} : ${a[2]})`;
        case "CONCATENATE":
        case "CONCAT":
          return `[${a.join(", ")}].map((x) => x ?? "").join("")`;
        case "LOWER":
          return `String(${a[0]} ?? "").toLowerCase()`;
        case "UPPER":
          return `String(${a[0]} ?? "").toUpperCase()`;
        case "TRIM":
          return `String(${a[0]} ?? "").trim()`;
        case "CONTAINS":
          return `String(${a[0]} ?? "").includes(${a[1]})`;
        case "LEN":
          return `String(${a[0]} ?? "").length`;
        default:
          throw new FormulaError(`${node.fn}() is not supported`);
      }
    }
  }
}

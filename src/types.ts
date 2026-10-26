import { FormulaError, type Node } from './formula.ts';
export type ValueType = 'string' | 'number' | 'boolean' | 'date' | 'null' | 'undefined';
export type StoredType = Exclude<ValueType, 'null' | 'undefined'>;
export type TypeResolver = (name: string, path: string[]) => ValueType;
function merge(a: ValueType, b: ValueType): ValueType {
  if (a === b) return a;
  if (a === 'null' || a === 'undefined') return b;
  if (b === 'null' || b === 'undefined') return a;
  throw new FormulaError(`Mixed result types ${a}/${b} need an explicit conversion`);
}
/** Infer calculation outputs independently of Clay's often text-labelled formulas. */
export function inferType(n: Node, resolve: TypeResolver): ValueType {
  const infer = (x: Node) => inferType(x, resolve);
  switch(n.k) {
    case 'str': return 'string';
    case 'num': return 'number';
    case 'bool': return 'boolean';
    case 'nullish': return n.v;
    case 'ref': return resolve(n.name,n.path);
    case 'unary':
      if(n.op==='!') return 'boolean';
      if(infer(n.arg)!=='number') throw new FormulaError('Unary minus needs a number');
      return 'number';
    case 'method': {
      if(infer(n.receiver)!=='string') throw new FormulaError(`${n.method}() requires a string receiver`);
      const numeric = ['slice','substring'].includes(n.method);
      for(const arg of n.args) if(infer(arg)!==(numeric?'number':'string')) throw new FormulaError(`${n.method}() requires ${numeric?'number':'string'} arguments`);
      return ['includes','startsWith','endsWith'].includes(n.method)?'boolean':'string';
    }
    case 'cond': return merge(infer(n.a),infer(n.b));
    case 'bin': {
      const a=infer(n.l),b=infer(n.r);
      if(['===','!==','==','!=','<','>','<=','>='].includes(n.op)) return 'boolean';
      if(['??','||','&&'].includes(n.op)) return merge(a,b);
      if(n.op==='+' && (a==='string'||b==='string')) return 'string';
      if(a!=='number'||b!=='number') throw new FormulaError(`${n.op} requires numeric operands; convert text explicitly`);
      return 'number';
    }
    case 'call': {
      const count=n.args.length;
      if(n.fn==='IF') {
        if(count!==3) throw new FormulaError('IF needs three arguments');
        return merge(infer(n.args[1]),infer(n.args[2]));
      }
      if(n.fn==='COALESCE') {
        if(!count) throw new FormulaError('COALESCE needs arguments');
        return n.args.map(infer).reduce(merge);
      }
      if(['CONCAT','CONCATENATE'].includes(n.fn)) {n.args.forEach(infer);return 'string';}
      const arity=n.fn==='CONTAINS'?2:1;
      if(count!==arity) throw new FormulaError(`${n.fn} needs ${arity} argument(s)`);
      n.args.forEach(infer);
      if(n.fn==='LEN') return 'number';
      if(n.fn==='CONTAINS') return 'boolean';
      if(['UPPER','LOWER','TRIM','DOMAIN','CLAY_FORMAT'].includes(n.fn)) return 'string';
      throw new FormulaError(`Unknown function ${n.fn}`);
    }
  }
}

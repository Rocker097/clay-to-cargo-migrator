import { FormulaError, type Node } from './formula.ts';
export type ValueType = 'string' | 'number' | 'boolean' | 'date' | 'null' | 'undefined' | 'array' | 'regex';
export type StoredType = Exclude<ValueType, 'null' | 'undefined' | 'array' | 'regex'>;
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
    case 'array': n.items.forEach(x=>{if(infer(x)!=='string')throw new FormulaError('Array items must be strings');});return 'array';
    case 'regex': return 'regex';
    case 'index': if(infer(n.receiver)!=='array')throw new FormulaError('Indexing requires an array');return 'string';
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
      if(n.method==='join'){if(infer(n.receiver)!=='array')throw new FormulaError('join requires an array');n.args.forEach(x=>{if(infer(x)!=='string')throw new FormulaError('join requires a string separator');});return 'string';}
      if(infer(n.receiver)!=='string') throw new FormulaError(`${n.method}() requires a string receiver`);
      const numeric = ['slice','substring'].includes(n.method);
      for(const [i,arg] of n.args.entries()) if(!(['replace','replaceAll'].includes(n.method)&&i===0&&infer(arg)==='regex') && infer(arg)!==(numeric?'number':'string')) throw new FormulaError(`${n.method}() requires ${numeric?'number':'string'} arguments`);
      if(n.method==='split')return 'array';
      return ['includes','startsWith','endsWith'].includes(n.method)?'boolean':'string';
    }
    case 'cond': return merge(infer(n.a),infer(n.b));
    case 'bin': {
      const a=infer(n.l),b=infer(n.r);
      if(['===','!==','==','!=','<','>','<=','>='].includes(n.op)) return 'boolean';
      if(['??','||','&&'].includes(n.op)) return merge(a,b);
      if(n.op==='-' && ['date','number'].includes(a) && ['date','number'].includes(b))return 'number';
      if(n.op==='+' && (a==='string'||b==='string')) return 'string';
      if(a!=='number'||b!=='number') throw new FormulaError(`${n.op} requires numeric operands; convert text explicitly`);
      return 'number';
    }
    case 'call': {
      const count=n.args.length;
      if(['DATE_VALUE','Date_now','Math_floor','Math_ceil','Math_round'].includes(n.fn)){if(count!==(n.fn==='Date_now'?0:1))throw new FormulaError('Invalid date/math arity');if(n.fn.startsWith('Math_')&&infer(n.args[0])!=='number')throw new FormulaError('Math requires a number');if(n.fn==='DATE_VALUE'&&!['string','number','date'].includes(infer(n.args[0])))throw new FormulaError('Date requires a scalar date input');return n.fn==='DATE_VALUE'?'date':'number';}
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

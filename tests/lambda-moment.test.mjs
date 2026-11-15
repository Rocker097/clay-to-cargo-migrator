// Arrow functions in array methods and moment() date math, as they appear
// in real Clay exports.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFormula, emitBody, emitLoader } from '../src/formula.ts';
import { parseClaySchema } from '../src/claymate.ts';
import { planMigration } from '../src/plan.ts';
import { clayMoment, readPath } from '../src/import-runtime.ts';

// The "skip validation if an earlier finder already found this email"
// run condition from a real table, with refs simplified to A, B, C.
const DEDUPE = '!([ {{@A}}?.email, {{@B}}?.email ]).filter(previousValue => !!previousValue).find(field => field === {{@C}}?.email) && {{@C}} && {{@C}}?.email';

test('workflow bodies unroll array methods over a literal list, matching JavaScript exactly', () => {
  const ast = parseFormula(DEDUPE);
  // As in a generated tool: each value the condition reads is its own flat
  // parameter (whenA_email), so the body never dereferences a missing object.
  const key = (n, path) => [n, ...path].join('_');
  const body = emitBody(ast, (n, path) => `input.${key(n, path)}`);
  assert.doesNotMatch(body, /=>|\?\.|\?\?|\|\|/, 'no arrow functions or banned operators in a Cargo body');
  const loader = emitLoader(ast, n => `row.${n}`);
  const values = [undefined, {}, { email: '' }, { email: 'a@x.com' }, { email: 'b@x.com' }];
  let cases = 0;
  for (const A of values) for (const B of values) for (const C of values) {
    const flat = {};
    for (const [n, v] of Object.entries({ A, B, C })) { flat[n] = v; flat[`${n}_email`] = v?.email; }
    const viaBody = new Function('input', `return ${body}`)(flat);
    const viaJs = new Function('row', `return ${loader}`)({ A, B, C });
    assert.equal(Boolean(viaBody), Boolean(viaJs), JSON.stringify({ A, B, C }));
    cases++;
  }
  assert.equal(cases, 125);
});

test('some/every/map unroll too; non-literal lists stay load-time only', () => {
  const r = (n) => `input.${n}`;
  const some = new Function('input', `return ${emitBody(parseFormula('[{{@A}}, {{@B}}].some(x => x === "y")'), r)}`);
  assert.equal(some({ A: 'n', B: 'y' }), true);
  assert.equal(some({ A: 'n', B: 'n' }), false);
  const every = new Function('input', `return ${emitBody(parseFormula('[{{@A}}, {{@B}}].map(x => x + "!").every(x => x !== "!")'), r)}`);
  assert.equal(every({ A: 'a', B: 'b' }), true);
  assert.equal(every({ A: '', B: 'b' }), false);
  assert.throws(() => emitBody(parseFormula('{{@A}}.filter(x => !!x).find(x => x === "a")'), r), /literal list/);
  assert.throws(() => emitBody(parseFormula('[{{@A}}].filter((v, i) => i === 0).find(x => !!x)'), r), /one-parameter/);
});

test('Clay de-duplication idiom runs at load time on a frozen JSON result', () => {
  const formula = '{{@P}}?.experience?.map(item => item?.company)?.filter((value, index, self) => self.indexOf(value) === index)?.join(", ")';
  const code = emitLoader(parseFormula(formula), () => 'row.p');
  assert.match(code, /p_item/, 'parameters are prefixed');
  const run = (p) => new Function('row', `return ${code}`)({ p });
  assert.equal(run({ experience: [{ company: 'Acme' }, { company: 'Beta' }, { company: 'Acme' }] }), 'Acme, Beta');
  assert.equal(run({}), undefined);
});

test('arrow functions are only accepted where they belong', () => {
  assert.throws(() => parseFormula('x => x'), /only as the argument/);
  assert.throws(() => parseFormula('{{@A}}.trim(x => x)'), /expects 0/);
  assert.throws(() => parseFormula('[{{@A}}].map("x")'), /needs an arrow function/);
  assert.throws(() => parseFormula('[{{@A}}].map(row => row)'), /not allowed/);
  assert.throws(() => parseFormula('[{{@A}}].map(x => y)'), /Unknown identifier "y"/);
});

test('moment(): month math clamps like moment, formats and compares in UTC', () => {
  const m = clayMoment('2026-03-31T10:20:30Z');
  assert.equal(m.subtract(1, 'months').format('YYYY-MM-DD'), '2026-02-28');
  assert.equal(clayMoment('2024-03-31T00:00:00Z').subtract(1, 'month').format('YYYY-MM-DD'), '2024-02-29');
  assert.equal(m.subtract(24, 'months').format('YYYYMMDDHHmmss'), '20240331102030');
  assert.equal(m.add(2, 'days').date(), 2);
  assert.equal(m.year(), 2026);
  assert.equal(m.isAfter(clayMoment('2026-01-01')), true);
  assert.equal(m.diff(clayMoment('2025-04-01T00:00:00Z'), 'months'), 11);
  assert.equal(clayMoment('not a date').format('YYYY'), 'Invalid date');
  assert.throws(() => m.subtract(1, 'fortnight'), /Unsupported moment unit/);
});

test('moment() formulas over inputs compute at load time; never in a workflow body', () => {
  const p = planMigration(parseClaySchema(JSON.stringify({ version: '1', columns: [
    { index: 0, name: 'End Date', type: 'text' },
    { index: 1, name: 'Recent', type: 'formula', typeSettings: { formulaText: "moment({{@End Date}}).isAfter(moment().subtract(6, 'months'))" } },
    { index: 2, name: 'Stamp', type: 'formula', typeSettings: { formulaText: '{{@End Date}} ? moment({{@End Date}})?.format("YYYYMMDD") : ""' } },
    { index: 3, name: 'Raw', type: 'formula', typeSettings: { formulaText: 'moment({{@End Date}})' } },
  ] })), 'm');
  const by = (n) => p.columns.find(c => c.clay.name === n);
  assert.equal(by('Recent').kind, 'loader-formula');
  assert.equal(by('Recent').cargoType, 'boolean');
  const run = (expr, row) => new Function('row', 'clayMoment', 'readPath', `return ${expr}`)(row, clayMoment, readPath);
  assert.equal(run(by('Recent').loaderExpr, { end_date: new Date().toISOString() }), true);
  assert.equal(run(by('Recent').loaderExpr, { end_date: '2001-01-01' }), false);
  assert.equal(run(by('Stamp').loaderExpr, { end_date: '2026-11-15T00:00:00Z' }), '20261115');
  assert.equal(by('Raw').generated, false, 'a moment object is not storable');
  assert.throws(() => emitBody(parseFormula('moment().year()'), () => 'x'), /only in input\/loader/);
});

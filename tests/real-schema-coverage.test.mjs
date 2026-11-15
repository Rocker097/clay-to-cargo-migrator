// Shapes taken from real ClayMate exports: waterfalls, deep result paths,
// answerSchemaType formulaMap, Clay sources replaced by CSV columns,
// system prompts, JSON.stringify in prompts and field-ID references.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFormula, emitBody, emitLoader } from '../src/formula.ts';
import { parseClaySchema } from '../src/claymate.ts';
import { planMigration } from '../src/plan.ts';
import { emitProject } from '../src/emit.ts';

const plan = (columns) => planMigration(parseClaySchema(JSON.stringify({ version: '1', columns: columns.map((c, index) => ({ index, ...c })) })), 'real');
const col = (p, name) => p.columns.find(c => c.clay.name === name);
const text = (name) => ({ name, type: 'text', typeSettings: { dataTypeSettings: { type: 'text' } } });
const ai = (name, bindings) => ({ name, type: 'action', typeSettings: { actionKey: 'use-ai', inputsBinding: bindings } });

test('waterfall formulas compile to first non-empty step', () => {
  const p = plan([text('A'), text('B'), { name: 'Pick', type: 'formula', typeSettings: { formulaType: 'waterfall', formulaWaterfall: ['{{@A}}', '{{@B}}'] } }]);
  const pick = col(p, 'Pick');
  assert.equal(pick.generated, true);
  assert.equal(pick.clay.typeSettings.formulaText, '({{@A}}) || ({{@B}})');
  const ast = parseFormula(pick.clay.typeSettings.formulaText);
  assert.ok(!emitBody(ast, n => `input.${n}`).includes('||'));
  assert.throws(() => parseClaySchema(JSON.stringify({ version: '1', columns: [{ index: 0, name: 'W', type: 'formula', typeSettings: { formulaWaterfall: [1] } }] })), /formulaWaterfall/);
});

test('indexes and string keys extend a reference path', () => {
  assert.deepEqual(parseFormula('{{@X}}?.people?.[0]?.name').path, ['people', '0', 'name']);
  assert.deepEqual(parseFormula('{{@X}}?.["12"]').path, ['12']);
  assert.equal(emitLoader(parseFormula('{{@X}}?.a?.[1]'), () => 'row'), 'row?.["a"]?.["1"]');
  for (const f of ['{{@X}}["__proto__"]', '{{@X}}.constructor', '{{@X}}?.["prototype"]']) assert.throws(() => parseFormula(f), /not allowed/);
});

test('answerSchemaType formulaMap fields become the agent output schema', () => {
  const fields = JSON.stringify({ response: { type: 'string', description: '', id: 'x', options: '' }, score: { type: 'number' } });
  const p = plan([text('Company'), ai('Research', [
    { name: 'prompt', formulaText: '"About " + {{@Company}}' },
    { name: 'answerSchemaType', formulaMap: { type: '"json"', fields } },
  ])]);
  const r = col(p, 'Research');
  assert.equal(r.generated, true);
  assert.deepEqual(r.aiOutputs, { response: 'string', score: 'number' });
});

test('answerSchemaType jsonSchema: flat schemas carry over, nested ones stay blocked', () => {
  const flat = JSON.stringify(JSON.stringify({ type: 'object', properties: { fit: { type: 'boolean' } } }));
  const nested = JSON.stringify(JSON.stringify({ type: 'object', properties: { data: { type: 'array', items: { type: 'object' } } } }));
  const ok = col(plan([text('C'), ai('A', [{ name: 'prompt', formulaText: '"x " + {{@C}}' }, { name: 'answerSchemaType', formulaMap: { type: '"json"', jsonType: '"JSONSchema"', jsonSchema: flat } }])]), 'A');
  assert.deepEqual(ok.aiOutputs, { fit: 'boolean' });
  const bad = col(plan([text('C'), ai('A', [{ name: 'prompt', formulaText: '"x " + {{@C}}' }, { name: 'answerSchemaType', formulaMap: { type: '"json"', jsonType: '"JSONSchema"', jsonSchema: nested } }])]), 'A');
  assert.equal(bad.generated, false);
  const num = col(plan([text('C'), ai('A', [{ name: 'prompt', formulaText: '"x " + {{@C}}' }, { name: 'answerSchemaType', formulaMap: { type: '"number"' } }])]), 'A');
  assert.equal(num.generated, false);
});

test('schema-less use-ai columns answer in response; system prompt carries over', () => {
  const p = plan([text('C'),
    ai('ICP', [{ name: 'useCase', formulaText: '"use-ai"' }, { name: 'systemPrompt', formulaText: '"You are an analyst."' }, { name: 'prompt', formulaText: '"Profile " + {{@C}}' }, { name: 'answerSchemaType' }]),
    { name: 'ICP Response', type: 'formula', typeSettings: { formulaText: '{{@ICP}}?.response' } }]);
  const icp = col(p, 'ICP');
  assert.equal(icp.generated, true);
  assert.equal(icp.aiSystemPrompt, 'You are an analyst.');
  assert.match(icp.promptTemplate, /Profile/);
  assert.equal(col(p, 'ICP Response').generated, true);
  const agent = emitProject(p).find(f => f.path.includes('/agents/'));
  assert.match(agent.content, /"You are an analyst\."/);
  const refs = col(plan([text('C'), ai('X', [{ name: 'systemPrompt', formulaText: '"Hi " + {{@C}}' }, { name: 'prompt', formulaText: '"p"' }])]), 'X');
  assert.equal(refs.generated, false);
});

test('Clay sources become CSV columns, one per field read', () => {
  const p = plan([
    { name: 'Imported Companies', type: 'source', typeSettings: {} },
    { name: 'Name', type: 'formula', typeSettings: { formulaText: '{{@Imported Companies}}.name' } },
    { name: 'Product', type: 'formula', typeSettings: { formulaText: '{{@Imported Companies}}?.products?.[0]?.product_name' } },
    { name: 'Lower', type: 'formula', typeSettings: { formulaText: '{{@Imported Companies}}.name.toLowerCase()' } },
    { name: 'Whole', type: 'formula', typeSettings: { formulaText: '{{@Imported Companies}}' } },
  ]);
  assert.equal(col(p, 'Imported Companies').generated, true);
  assert.equal(col(p, 'Imported Companies.name').kind, 'input');
  assert.equal(col(p, 'Imported Companies.name').slug, 'src_name');
  assert.ok(col(p, 'Imported Companies.products.0.product_name'));
  for (const n of ['Name', 'Product', 'Lower']) assert.equal(col(p, n).kind, 'loader-formula', n);
  assert.equal(col(p, 'Lower').loaderExpr.includes('toLowerCase'), true);
  assert.equal(col(p, 'Whole').generated, false);
  assert.ok(col(p, 'Imported Companies.name').verify.length, 'CSV column must be flagged for review');
});

test('JSON.stringify in prompts, field-ID references explained', () => {
  const p = plan([text('Domain'), ai('A', [{ name: 'prompt', formulaText: '"Domain: " + JSON.stringify({{@Domain}})' }])]);
  assert.equal(col(p, 'A').generated, true);
  assert.equal(emitLoader(parseFormula('JSON.stringify({{@D}})'), () => 'v'), 'JSON.stringify(v)');
  assert.throws(() => parseFormula('JSON.parse({{@D}})'), /JSON.stringify/);
  assert.throws(() => parseFormula('{{f_created_at}}'), /row creation time/);
  assert.throws(() => parseFormula('{{f_abc123}}'), /field-ID/);
});

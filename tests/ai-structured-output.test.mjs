// Structured AI output: Clay AI columns that declare output fields carry them
// into the Cargo agent's output schema, so downstream formulas can read them.
import test from 'node:test';
import assert from 'node:assert/strict';
import {planMigration, parseAiOutputContract} from '../src/plan.ts';
import {emitProject} from '../src/emit.ts';

const text = (index, name) => ({index, name, type: 'text', typeSettings: {dataTypeSettings: {type: 'text'}}});
const formula = (index, name, formulaText, type = 'text') => ({index, name, type: 'formula', typeSettings: {dataTypeSettings: {type}, formulaType: type, formulaText}});
const ai = (index, name, bindings, extra = {}) => ({
  index, name, type: 'action',
  typeSettings: {dataTypeSettings: {type: 'json'}, actionKey: 'use-ai', inputsBinding: bindings.map(([n, f]) => ({name: n, formulaText: f})), ...extra},
});
const schema = columns => ({version: '1.0', columns});
const col = (plan, name) => plan.columns.find(c => c.clay.name === name);

test('parses Clay shorthand, full JSON Schema, field lists and JSON strings', () => {
  assert.deepEqual(parseAiOutputContract({score: 'number', reason: 'string'}, 'x'), {score: 'number', reason: 'string'});
  assert.deepEqual(parseAiOutputContract('{"score":"number","hot":"boolean"}', 'x'), {score: 'number', hot: 'boolean'});
  assert.deepEqual(parseAiOutputContract({type: 'object', properties: {score: {type: 'integer'}, reason: {type: 'string'}}}, 'x'), {score: 'number', reason: 'string'});
  assert.deepEqual(parseAiOutputContract([{name: 'tier', type: 'text'}], 'x'), {tier: 'string'});
  assert.deepEqual(parseAiOutputContract({type: 'json_schema', json_schema: {schema: {type: 'object', properties: {a: {type: 'number'}}}}}, 'x'), {a: 'number'});
  assert.equal(parseAiOutputContract('"json"', 'x'), undefined);
  assert.equal(parseAiOutputContract({type: 'json_schema'}, 'x'), undefined);
});

test('refuses nested, unknown-typed, empty or unreadable contracts', () => {
  assert.throws(() => parseAiOutputContract({tags: 'array'}, 'x'), /only string, number and boolean/);
  assert.throws(() => parseAiOutputContract({type: 'object', properties: {meta: {type: 'object'}}}, 'x'), /only string, number and boolean/);
  assert.throws(() => parseAiOutputContract({}, 'x'), /declares no fields/);
  assert.throws(() => parseAiOutputContract('{not json', 'x'), /not readable JSON/);
  assert.throws(() => parseAiOutputContract({raw: 'string'}, 'x'), /collides/);
  assert.throws(() => parseAiOutputContract({'bad name': 'string'}, 'x'), /valid identifier/);
});

test('shorthand json_schema binding migrates the AI column and its dependents', () => {
  const p = planMigration(schema([
    text(0, 'Company'),
    ai(1, 'Fit', [['prompt', 'Score {{@Company}} for fit.'], ['response_format', '"json"'], ['json_schema', '{"score":"number","reason":"string"}']]),
    formula(2, 'Fit Score', '{{@Fit}}?.score', 'number'),
    formula(3, 'Hot', '{{@Fit Score}} >= 8', 'boolean'),
    ai(4, 'Opener', [['prompt', 'Write an opener for {{@Company}}. Fit: {{@Fit Score}}.']], {conditionalRunFormulaText: '{{@Hot}}'}),
  ]), 'structured');
  const fit = col(p, 'Fit');
  assert.equal(fit.generated, true);
  assert.deepEqual(fit.aiOutputs, {score: 'number', reason: 'string'});
  assert.match(fit.notes.join(' '), /Structured AI output carried over: score \(number\), reason \(string\)/);
  assert.equal(col(p, 'Fit Score').generated, true);
  assert.equal(col(p, 'Fit Score').cargoType, 'number');
  assert.equal(col(p, 'Hot').generated, true);
  assert.equal(col(p, 'Opener').generated, true);
  assert.ok(col(p, 'Opener').toolCondition);
});

test('typeSettings.outputSchema with full JSON Schema is carried into the agent and tool', () => {
  const p = planMigration(schema([
    text(0, 'Company'),
    ai(1, 'Fit', [['prompt', 'Score {{@Company}}.']], {outputSchema: {type: 'object', properties: {score: {type: 'number'}, reason: {type: 'string'}}, required: ['score', 'reason']}}),
    formula(2, 'Fit Reason', '{{@Fit}}?.reason'),
  ]), 'agent');
  const files = emitProject(p);
  const agent = files.find(f => f.path.includes('/agents/')).content;
  assert.match(agent, /score: \{ type: "number" \}/);
  assert.match(agent, /reason: \{ type: "string" \}/);
  assert.match(agent, /required: \["score","reason"\]/);
  assert.doesNotMatch(agent, /answer:/);
  const tool = files.find(f => f.path.includes('/tools/fit')).content;
  assert.match(tool, /score: result\.answer\.score,/);
  assert.match(tool, /reason: result\.answer\.reason,/);
  assert.match(tool, /score: z\.number\(\)\.optional\(\)/);
  const play = files.find(f => f.path.includes('/plays/')).content;
  const code = play.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(code, /\?\.|\?\?/);
});

test('reading a field not declared in the schema blocks with a clear reason', () => {
  const p = planMigration(schema([
    text(0, 'Company'),
    ai(1, 'Fit', [['prompt', 'Score {{@Company}}.'], ['json_schema', '{"score":"number"}']]),
    formula(2, 'Tier', '{{@Fit}}?.tier'),
  ]), 'undeclared');
  assert.equal(col(p, 'Fit').generated, true);
  assert.equal(col(p, 'Tier').generated, false);
  assert.match(col(p, 'Tier').notes.join(' '), /not declared in "Fit"'s output schema/);
});

test('AI columns without a schema still produce a single answer field', () => {
  const p = planMigration(schema([text(0, 'Company'), ai(1, 'Summary', [['prompt', 'Summarize {{@Company}}.']])]), 'plain');
  const agent = emitProject(p).find(f => f.path.includes('/agents/')).content;
  assert.match(agent, /answer: \{ type: "string", description: "The answer to the prompt\." \}/);
  assert.match(agent, /required: \["answer"\]/);
});

// --freeze-blocked: columns Cargo cannot re-run load Clay's value from the
// CSV, so the columns that read them still migrate.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseClaySchema } from '../src/claymate.ts';
import { planMigration } from '../src/plan.ts';
import { emitProject } from '../src/emit.ts';
import { inspectPlan } from '../src/inspect.ts';
import { prepareRows, readPath } from '../src/import-runtime.ts';

const schema = (columns) => parseClaySchema(JSON.stringify({ version: '1', columns: columns.map((c, index) => ({ index, ...c })) }));
const columns = [
  { name: 'Company', type: 'text' },
  { name: 'Shot', type: 'action', typeSettings: { actionKey: 'screen-shot-get-page', inputsBinding: [{ name: 'url', formulaText: '{{@Company}}' }] } },
  { name: 'Shot URL', type: 'formula', typeSettings: { formulaText: '{{@Shot}}?.screenshot_url' } },
  { name: 'Label', type: 'formula', typeSettings: { formulaText: '{{@Company}} + ": " + {{@Shot}}?.screenshot_url' } },
  { name: 'Push', type: 'action', typeSettings: { actionKey: 'write-to-other-table-v2', inputsBinding: [] } },
  { name: 'CRM', type: 'action', typeSettings: { actionKey: 'hubspot-create-object', inputsBinding: [] } },
];

test('off by default: nothing is frozen', () => {
  const p = planMigration(schema(columns), 'f');
  assert.equal(p.columns.find(c => c.clay.name === 'Shot').generated, false);
  assert.equal(p.columns.find(c => c.clay.name === 'Shot URL').generated, false);
});

test('blocked columns freeze, readers migrate, writes never freeze', () => {
  const p = planMigration(schema(columns), 'f', { freezeBlocked: true });
  const by = (n) => p.columns.find(c => c.clay.name === n);
  assert.equal(by('Shot').frozen, true);
  assert.equal(by('Shot').kind, 'input');
  assert.match(by('Shot').verify[0], /new rows added in Cargo will not compute it/);
  assert.equal(by('Shot URL').generated, true);
  assert.equal(by('Label').generated, true);
  assert.equal(by('Push').generated, false);
  assert.equal(by('CRM').generated, false);
  const status = Object.fromEntries(inspectPlan(p).columns.map(c => [c.name, c.status]));
  assert.equal(status.Shot, 'review');
  // The field read off the frozen column becomes one load-time column, shared.
  assert.equal(p.columns.filter(c => c.clay.name === 'Shot → screenshot_url').length, 1);
});

test('loader reads fields out of the JSON Clay exported, and fails soft on display values', () => {
  const p = planMigration(schema(columns.slice(0, 4)), 'f', { freezeBlocked: true });
  const loader = emitProject(p).find(f => f.path.endsWith('load-rows.ts')).content;
  assert.match(loader, /readPath\(row\["shot"\], \["screenshot_url"\]\)/);
  const inputs = p.columns.filter(c => c.kind === 'input').map(c => ({ clay: c.clay.name, slug: c.slug, type: c.cargoType }));
  const formulas = p.columns.filter(c => c.kind === 'loader-formula').map(c => ({ slug: c.slug, compute: new Function('row', 'readPath', `return ${c.loaderExpr}`) }))
    .map(f => ({ slug: f.slug, compute: (row) => f.compute(row, readPath) }));
  const csv = 'Company,Shot\nAcme,"{""screenshot_url"":""https://x/1.png""}"\nBeta,View image\n';
  const rows = prepareRows(csv, inputs, formulas, [], { limit: 10, source: 's' }).map(r => r.data);
  const label = p.columns.find(c => c.clay.name === 'Label').slug;
  assert.equal(rows[0][label], 'Acme: https://x/1.png');
  assert.equal(rows[1][p.columns.find(c => c.clay.name === 'Shot URL').slug], undefined);
  assert.equal(readPath('{"a":{"b":[1,{"c":"x"}]}}', ['a', 'b', '1', 'c']), 'x');
  assert.equal(readPath('{"a":{"b":1}}', ['a']), '{"b":1}');
  assert.equal(readPath('{"a":1}', ['__proto__']), undefined);
});

test('AI prompts can read a scalar enrichment field; string checks compile in bodies', async () => {
  const { emitBody, parseFormula } = await import('../src/formula.ts');
  const p = planMigration(schema([
    { name: 'Domain', type: 'text' },
    { name: 'Enrich', type: 'action', typeSettings: { actionKey: 'enrich-company-with-mixrank-v2', inputsBinding: [{ name: 'company_identifier', formulaText: '{{@Domain}}' }] } },
    { name: 'ICP', type: 'action', typeSettings: { actionKey: 'use-ai', inputsBinding: [{ name: 'prompt', formulaText: '"About: " + {{@Enrich}}?.description' }] } },
    { name: 'Whole', type: 'action', typeSettings: { actionKey: 'use-ai', inputsBinding: [{ name: 'prompt', formulaText: '"Data: " + {{@Enrich}}' }] } },
  ]), 'f');
  const icp = p.columns.find(c => c.clay.name === 'ICP');
  assert.equal(icp.generated, true);
  assert.ok(icp.toolParams.some(t => t.playExpr === 'rEnrich.description'));
  assert.equal(p.columns.find(c => c.clay.name === 'Whole').generated, false, 'whole result objects still need review');
  assert.equal(emitBody(parseFormula('{{@X}}?.startsWith("http")'), () => 'v'), '(v ? v.startsWith("http") : false)');
});

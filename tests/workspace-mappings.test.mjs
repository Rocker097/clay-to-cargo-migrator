// Every action mapping is checked against the real Cargo workspace schema
// (tests/fixtures/cargo-workspace-actions.json, exported with
// `cargo-ai connection integration list`). A mapping that names an input or
// output field the workspace does not have fails here, before generation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ACTION_MAPPINGS } from '../src/mappings.ts';
import { parseClaySchema } from '../src/claymate.ts';
import { planMigration } from '../src/plan.ts';
import { emitProject } from '../src/emit.ts';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/cargo-workspace-actions.json', import.meta.url), 'utf8'));
const ws = fixture.actions;
const connectors = fixture.connectors;

function at(schema, path) {
  let s = schema;
  for (const step of path) {
    if (!s) return undefined;
    if (/^\d+$/.test(step)) { s = s.items; continue; }
    s = s.properties?.[step];
  }
  return s;
}
const typeOf = (s) => [s?.type].flat().filter(t => t !== 'null');

for (const m of ACTION_MAPPINGS) {
  test(`mapping ${m.id} matches ${m.connector.integration}.${m.action} in the workspace`, () => {
    const action = ws[`${m.connector.integration}.${m.action}`];
    assert.ok(action, 'action exists in the workspace');
    assert.equal(m.connector.slug, connectors[m.connector.integration], 'connector slug matches the connected workspace connector');
    const inputs = action.input.properties;
    for (const p of m.params) assert.ok(inputs[p.cargoField], `input ${p.cargoField} exists`);
    for (const k of Object.keys(m.constants ?? {})) assert.ok(inputs[k], `constant ${k} is an input`);
    const supplied = new Set([...m.params.filter(p => p.required).map(p => p.cargoField), ...Object.keys(m.constants ?? {})]);
    for (const r of action.input.required) assert.ok(supplied.has(r), `required input ${r} is always supplied`);
    for (const [field, type] of Object.entries(m.knownOutputs)) {
      const s = at(action.output, m.outputPaths?.[field] ?? [field]);
      assert.ok(s, `output ${field} exists`);
      assert.ok(typeOf(s).includes(type), `output ${field} is ${type}, workspace says ${typeOf(s)}`);
    }
  });
}

const plan = (columns) => planMigration(parseClaySchema(JSON.stringify({ version: '1', columns: columns.map((c, index) => ({ index, ...c })) })), 'ws');
const text = (name) => ({ name, type: 'text' });
const action = (name, actionKey, inputsBinding) => ({ name, type: 'action', typeSettings: { actionKey, inputsBinding } });
const formula = (name, formulaText) => ({ name, type: 'formula', typeSettings: { formulaText } });
const col = (p, n) => p.columns.find(c => c.clay.name === n);

test('Clay v2 email finders: full name + domain, alias copies dropped, same-vendor where possible', () => {
  const fan = ['name', 'fullName', 'full_name', 'fullname'].map(n => ({ name: n, formulaText: '{{@Full Name}}' }))
    .concat(['domain', 'url', 'companyDomain', 'company_domain', 'website'].map(n => ({ name: n, formulaText: '{{@Domain}}' })));
  for (const [key, id, swap] of [['findymail-find-work-email', 'find-email-full-name', false], ['prospeo-find-work-email-v2', 'find-email-prospeo', false], ['leadmagic-find-work-email', 'find-email-full-name', true]]) {
    const p = plan([text('Full Name'), text('Domain'), action('Email', key, fan), formula('Out', '{{@Email}}?.email')]);
    const c = col(p, 'Email');
    assert.equal(c.generated, true, key);
    assert.equal(c.mapping.id, id, key);
    assert.equal(Boolean(c.providerSwap), swap, key);
    assert.equal(col(p, 'Out').generated, true);
  }
  // A different value under an unknown name is still refused.
  const p = plan([text('Full Name'), text('Domain'), text('Other'), action('Email', 'findymail-find-work-email', [...fan, { name: 'extra', formulaText: '{{@Other}}' }])]);
  assert.equal(col(p, 'Email').generated, false);
});

test('Mixrank person: LinkedIn URL inputs go to enrichProfile with experience fields; other identifiers do not', () => {
  const p = plan([text('LI URL'), action('Person', 'enrich-person-with-mixrank-v2', [{ name: 'person_identifier', formulaText: '{{@LI URL}}' }]),
    formula('Co', '{{@Person}}?.experience?.[1]?.company'), formula('Title', '{{@Person}}?.title'), formula('Ended', '{{@Person}}?.experience?.[0]?.end_date')]);
  assert.equal(col(p, 'Person').mapping.id, 'person-from-linkedin');
  assert.equal(col(p, 'Co').generated, true);
  assert.equal(col(p, 'Title').generated, true);
  assert.equal(col(p, 'Ended').generated, false, 'end_date has no workspace counterpart');
  const tool = emitProject(p).find(f => f.path.endsWith('tools/person.ts')).content;
  assert.match(tool, /result\.experiences\[1\]\.company/);
  assert.doesNotMatch(tool, /\?\.|\?\?/);
  const byEmail = plan([text('Email'), action('Person', 'enrich-person-with-mixrank-v2', [{ name: 'person_identifier', formulaText: '{{@Email}}' }])]);
  assert.equal(col(byEmail, 'Person').generated, false);
});

test('company_identifier holding a LinkedIn URL uses enrichCompany, not domain normalization', () => {
  const p = plan([text('Company LinkedIn'), action('Co', 'enrich-company-with-mixrank-v2', [{ name: 'company_identifier', formulaText: '{{@Company LinkedIn}}' }])]);
  assert.equal(col(p, 'Co').mapping.id, 'company-from-linkedin');
  const d = plan([text('Domain'), action('Co', 'enrich-company-with-mixrank-v2', [{ name: 'company_identifier', formulaText: '{{@Domain}}' }])]);
  assert.equal(col(d, 'Co').mapping.id, 'company-from-domain');
});

test('Apollo organization fields resolve through organization.*', () => {
  const p = plan([text('Domain'), action('Apollo', 'apollo-enrich-company', [{ name: 'domain', formulaText: '{{@Domain}}' }]),
    formula('Employees', '{{@Apollo}}?.organization?.estimated_num_employees')]);
  assert.equal(col(p, 'Employees').generated, true);
  assert.equal(col(p, 'Employees').cargoType, 'number');
  assert.match(emitProject(p).find(f => f.path.endsWith('tools/apollo.ts')).content, /result\.organization\.estimated_num_employees/);
});

test('scrape: fixed Firecrawl arguments, Clay-only settings dropped and listed', () => {
  const p = plan([text('URL'), action('Scrape', 'scrape-website', [{ name: 'url', formulaText: '{{@URL}}' }, { name: 'customRegex', formulaText: '".*?"' }, { name: 'waitFor' }]),
    formula('Body', '{{@Scrape}}?.bodyText')]);
  const c = col(p, 'Scrape');
  assert.equal(c.generated, true);
  assert.ok(c.verify.some(v => v.includes('customRegex')));
  assert.equal(col(p, 'Body').generated, true);
  const tool = emitProject(p).find(f => f.path.endsWith('tools/scrape.ts')).content;
  assert.match(tool, /formats: \["markdown"\]/);
  assert.match(tool, /includeFullPage: false/);
});

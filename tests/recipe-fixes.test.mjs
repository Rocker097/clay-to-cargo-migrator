// Fixes grounded in Cargo's clay-to-cargo recipe
// (getcargohq/cargo-skills, cargo-gtm/recipes/clay-to-cargo.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {planMigration} from '../src/plan.ts';
import {emitProject} from '../src/emit.ts';
import {prepareRows} from '../src/import-runtime.ts';

const text = (index, name) => ({index, name, type: 'text', typeSettings: {dataTypeSettings: {type: 'text'}}});
const action = (index, name, actionKey, inputs, extra = {}) => ({
  index, name, type: 'action',
  typeSettings: {dataTypeSettings: {type: 'json'}, actionKey, inputsBinding: inputs.map(([n, f]) => ({name: n, formulaText: f})), ...extra},
});
const schema = columns => ({version: '1.0', columns});
const col = (plan, name) => plan.columns.find(c => c.clay.name === name);

test('an enrich-person action with only an email is a reverse lookup, not LinkedIn profile enrichment', () => {
  const p = planMigration(schema([text(0, 'Email'), action(1, 'Apollo Person', 'apollo-enrich-person', [['email', '{{@Email}}']])]), 'apollo');
  const c = col(p, 'Apollo Person');
  assert.equal(c.kind, 'known-unverified');
  assert.equal(c.generated, false);
  assert.match(c.notes.join(' '), /reverseEmailLookup/);
  assert.doesNotMatch(c.notes.join(' '), /enrichProfile/);
});

test('finding a LinkedIn URL from name + company is not mapped to enriching an existing profile', () => {
  const p = planMigration(schema([
    text(0, 'First'), text(1, 'Last'), text(2, 'Company'),
    action(3, 'Find LinkedIn', 'find-linkedin-profile-url', [['first_name', '{{@First}}'], ['last_name', '{{@Last}}'], ['company', '{{@Company}}']]),
  ]), 'findli');
  const c = col(p, 'Find LinkedIn');
  assert.equal(c.kind, 'known-unverified');
  assert.match(c.notes.join(' '), /enrichContact/);
});

test('LinkedIn profile enrichment still maps when a LinkedIn URL input exists, with the recipe tip', () => {
  const p = planMigration(schema([text(0, 'LinkedIn'), action(1, 'Person', 'linkedin-enrich-person-profile', [['linkedin_url', '{{@LinkedIn}}']])]), 'li');
  const c = col(p, 'Person');
  assert.equal(c.generated, true);
  assert.equal(c.mapping.id, 'person-from-linkedin');
  assert.match(c.notes.join(' '), /aiArk\.enrichPerson/);
  assert.equal(c.verify.some(v => /aiArk/.test(v)), false);
});

test('a mapping is skipped when the column inputs cannot fill its required fields', () => {
  // Keywords say "find email", but there is no name or domain input to use.
  const p = planMigration(schema([text(0, 'Phone'), action(1, 'Email', 'hunter-find-email', [['phone', '{{@Phone}}']])]), 'nofit');
  const c = col(p, 'Email');
  assert.equal(c.generated, false);
  assert.equal(c.mapping, undefined);
});

test('Claygent and web-research prompts warn that the agent cannot browse', () => {
  const p = planMigration(schema([
    text(0, 'Domain'), text(1, 'Company'),
    action(2, 'Research', 'claygent', [['prompt', 'Browse {{@Domain}} and find their pricing page.']]),
    action(3, 'Summary', 'use-ai', [['prompt', 'Summarize {{@Company}} in one sentence.']]),
  ]), 'ai');
  assert.match(col(p, 'Research').verify.join(' '), /cannot browse/);
  assert.match(col(p, 'Research').verify.join(' '), /prompt-library/);
  assert.doesNotMatch(col(p, 'Summary').verify.join(' '), /cannot browse/);
});

test('CSV problems are all reported at once, with row numbers, and nothing is imported', () => {
  const inputs = [{clay: 'ID', slug: 'id_col', type: 'string'}, {clay: 'Count', slug: 'count', type: 'number'}];
  const csv = 'ID,Count\na,1\na,2\n,3\nb,lots\nc,4\n';
  assert.throws(
    () => prepareRows(csv, inputs, [], [], {limit: 20, source: 't', idColumn: 'ID'}),
    err => {
      assert.match(err.message, /3 problem\(s\); nothing was imported/);
      assert.match(err.message, /row 2: duplicate source ID a \(first seen on row 1\)/);
      assert.match(err.message, /row 3: blank stable ID/);
      assert.match(err.message, /row 4: "Count": Invalid numeric input lots/);
      return true;
    },
  );
  assert.equal(prepareRows('ID,Count\na,1\nb,2\n', inputs, [], [], {limit: 20, source: 't', idColumn: 'ID'}).length, 2);
});

test('the generated loader types its constants and annotates the .ts runtime import', () => {
  const p = planMigration(schema([text(0, 'Domain'), action(1, 'Company', 'clearbit-enrich-company', [['domain', '{{@Domain}}']])]), 'typed');
  const loader = emitProject(p).find(f => f.path.endsWith('load-rows.ts')).content;
  assert.match(loader, /const FORMULAS:FormulaSpec\[\]=/);
  assert.match(loader, /const INPUTS:InputSpec\[\]=/);
  assert.match(loader, /@ts-ignore TS5097[^\n]*\nimport \{prepareRows/);
  assert.match(loader, /catch\(error\)\{console\.error/);
});

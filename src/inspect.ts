import { ACTION_MAPPINGS } from './mappings.ts';
import type { MigrationPlan, MappingOverrides } from './plan.ts';

/** JSON mappings select reviewed adapters, never arbitrary executable code. */
export function parseOverrides(text: string): MappingOverrides {
  const value = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => k !== 'actions')) throw new Error('Mappings must be an object containing only actions.');
  if (value.actions !== undefined && (!value.actions || typeof value.actions !== 'object' || Array.isArray(value.actions))) throw new Error('actions must be an object.');
  for (const [key, id] of Object.entries(value.actions ?? {})) {
    if (!key || typeof id !== 'string' || !ACTION_MAPPINGS.some(m => m.id === id)) throw new Error(`Invalid adapter for ${key}: ${id}`);
  }
  return value;
}

export function inspectPlan(plan: MigrationPlan) {
  const columns = plan.columns.map((c, order) => {
    const settings = c.clay.typeSettings ?? {};
    const expressions = [settings.formulaText, settings.conditionalRunFormulaText, ...(settings.inputsBinding ?? []).map(b => b.formulaText)];
    const dependencies = [...new Set(expressions.flatMap(t => [...(t ?? '').matchAll(/\{\{@([^}]+)\}\}/g)].map(m => m[1].trim())))];
    return {
      name: c.clay.name, sourceType: c.clay.type, cargoColumn: c.slug,
      executionOrder: order + 1, dependencies,
      status: !c.generated ? 'blocked' : c.verify.length || c.providerSwap || c.notes.some(n => n.includes('dropped')) ? 'review' : 'supported',
      kind: c.kind, adapter: c.mapping?.id,
      targetAction: c.mapping ? `${c.mapping.connector.integration}.${c.mapping.action}` : undefined,
      formula: settings.formulaText, condition: settings.conditionalRunFormulaText,
      notes: c.notes, verification: c.verify,
    };
  });
  return {
    formatVersion: 1, name: plan.name, columnCount: columns.length,
    supported: columns.filter(c => c.status === 'supported').length,
    review: columns.filter(c => c.status === 'review').length,
    blocked: columns.filter(c => c.status === 'blocked').length,
    readyToGenerate: columns.every(c => c.status !== 'blocked'),
    // Generation is not proof of semantic equivalence or a successful paid run.
    columns,
    availableAdapters: ACTION_MAPPINGS.map(m => ({ id: m.id, job: m.job })),
  };
}

import { refsOf } from './formula.ts';
import type { MigrationPlan } from './plan.ts';
/** Versioned intermediate representation: independent of generated file layout. */
export function normalizedWorkflow(plan: MigrationPlan) {
  return {
    version: 1,
    name: plan.name,
    nodes: plan.columns.map(c=>({
      id: c.slug, sourceName: c.clay.name, operation: c.kind,
      outputType: c.cargoType, typeSource: c.typeSource ?? 'adapter',
      dependencies: c.expression ? [...new Set(refsOf(c.expression).map(r=>r.name))] : [...new Set([c.clay.typeSettings?.conditionalRunFormulaText,...(c.clay.typeSettings?.inputsBinding??[]).map(b=>b.formulaText)].flatMap(t=>[...(t??"").matchAll(/\{\{@([^}]+)\}\}/g)].map(m=>m[1].trim())))],
      expression: c.expression,
      execution: c.kind==='input'||c.kind==='loader-formula'?'import':'cargo',
      missingValues: c.expression?'See explicit optional access / nullish operators in expression':'Adapter-defined; review provider contract',
      adapter: c.mapping?.id,
      existingValueReuse: c.reuse ?? null,
      adaptation: c.providerSwap,
      generated: c.generated,
    })),
  };
}

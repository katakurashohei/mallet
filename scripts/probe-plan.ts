// Prints the joints and the naive vs. planned sequence of every model preset.
import { buildModel } from '../src/assembly/model';
import { plan, evalOrder, DEFAULT_WEIGHTS, Plan } from '../src/assembly/planner';
import { MODEL_PRESETS } from '../src/assembly/presets';

for (const def of MODEL_PRESETS) {
  const m = buildModel(def);
  console.log(`\n== ${def.name}: ${m.joints.length} joints`);
  for (const j of m.joints)
    console.log(`  ${m.plates[j.a].name}-${m.plates[j.b].name} ${j.kind} ${j.angle.toFixed(0)}° ${j.concave ? 'concave' : ''}`);
  const show = (label: string, p: Plan) => {
    console.log(`  ${label}: cost=${p.cost.toFixed(0)} feasible=${p.feasible}`);
    for (const s of p.steps)
      console.log(
        `    + ${m.plates[s.plate].name.padEnd(13)} c=${s.cost} ${s.rotary ? 'ROTARY ' : ''}dir=${s.dir?.map((v) => v.toFixed(2))} ${s.issues.map((i) => i.tag + i.cost).join(' ')}`,
      );
  };
  show('naive', evalOrder(m, def.naive, DEFAULT_WEIGHTS));
  const L = plan(m, DEFAULT_WEIGHTS);
  show(`plan (expanded ${L.expanded})`, L.plan);
}

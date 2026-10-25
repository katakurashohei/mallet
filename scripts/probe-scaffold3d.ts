// Which assembly steps need trapezoidal scaffolding (runs the FEA per step).
import { buildModel } from '../src/assembly/model';
import { plan, evalOrder, DEFAULT_WEIGHTS } from '../src/assembly/planner';
import { MODEL_PRESETS } from '../src/assembly/presets';
import { analyze, DEFAULT_PARAMS } from '../src/scaffold/analyze';
import { scaffoldJob, toScaffold3D } from '../src/assembly/scaffold3d';

for (const def of MODEL_PRESETS) {
  const m = buildModel(def);
  const steps = [...plan(m, DEFAULT_WEIGHTS).plan.steps, ...evalOrder(m, def.naive, DEFAULT_WEIGHTS).steps];
  const seen = new Set<string>();
  for (const s of steps) {
    const job = scaffoldJob(m, s);
    const tag = `${def.name.padEnd(12)} ${m.plates[s.plate].name.padEnd(17)}`;
    if (!job) { if (s.dir || s.rotary) console.log(`${tag} -- no in-plane strike (${s.rotary ? 'rotary' : 'face'})`); continue; }
    if (seen.has(job.key)) continue;
    seen.add(job.key);
    const sc = toScaffold3D(job, analyze(job.spec, { ...DEFAULT_PARAMS, margin: 25 }));
    console.log(`${tag} ${job.onA ? `on A via ${m.plates[job.plate].name}` : 'on P'} L=${job.spec.L.toFixed(0)} pins=${job.spec.pins} ${sc.needed ? `SCAFFOLD (${sc.polys.length} piece) [${sc.fails.map((f) => f.issue).join(',')}]` : 'ok'}`);
  }
}

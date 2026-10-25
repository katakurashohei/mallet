// Prints the analysis of every plate preset; used to tune thresholds.
import { analyze, DEFAULT_PARAMS } from '../src/scaffold/analyze';
import { PLATE_PRESETS } from '../src/scaffold/presets';

for (const spec of PLATE_PRESETS) {
  const a = analyze(spec, DEFAULT_PARAMS);
  const s = a.base.strike;
  const t = a.base.targets[s.targets[0]];
  console.log(
    `${spec.id.padEnd(9)} cells=${a.base.cells} ${a.ms.toFixed(0)}ms | base eff=${s.eff.toFixed(2)} F=${s.Freq.toFixed(0)}N p=${s.pressure.toFixed(1)} σ=${s.sigmaMax.toFixed(1)} ok=${s.ok}` +
      (t ? ` tgt=(${t.p.map((v) => v.toFixed(0))}) w=${t.width.toFixed(0)}` : '') +
      ` [${s.fails.map((f) => f.issue).join(',')}]`,
  );
  if (a.scaffold) {
    const ss = a.scaffold.stage.strike;
    console.log(
      `          scaffold k=${a.scaffold.k} eff=${ss.eff.toFixed(2)} F=${ss.Freq.toFixed(0)} p=${ss.pressure.toFixed(1)} σ=${ss.sigmaMax.toFixed(1)} ok=${ss.ok} tabs=${a.scaffold.tabs.length} pieces=${a.scaffold.pieces.length} tried=${JSON.stringify(a.scaffold.tried.map((x) => [x.k, x.ok, +x.eff.toFixed(2)]))} [${ss.fails.map((f) => f.issue).join(',')}]`,
    );
  }
}

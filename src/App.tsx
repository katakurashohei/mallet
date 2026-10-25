import { useState } from 'react';
import ScaffoldLab from './scaffold/ScaffoldLab';
import AssemblyPlanner from './assembly/AssemblyPlanner';

export default function App() {
  const [scaffoldPreset, setScaffoldPreset] = useState('leaning');
  const [model, setModel] = useState('chair');

  return (
    <>
      <div className="wrap">
        <nav className="sitenav">
          <a href="#scaffold">trapezoidal scaffolding</a> &nbsp;|&nbsp; <a href="#assembly">constrain-before-insertion</a>
        </nav>
      </div>

      <section className="block wrap" id="scaffold">
        <div className="sec-head"><h2>Trapezoidal scaffolding</h2></div>
        <p className="sec-intro">
          Every exposed edge of plate <b style={{ color: 'var(--plate-ink)' }}>P</b> is a candidate target. A finite-element
          solve shows how much of a strike there reaches each pin of the joint. If no edge works, the plate gets a
          sacrificial <b style={{ color: 'var(--scaffold-ink)' }}>trapezoid</b> with a flat 3&nbsp;cm target centred over the
          joint, attached by a break-away tab. Drag the vertices to try your own plate.
        </p>
        <ScaffoldLab presetId={scaffoldPreset} onPreset={setScaffoldPreset} />
      </section>

      <section className="block wrap" id="assembly">
        <div className="sec-head"><h2>Constrain-before-insertion</h2></div>
        <p className="sec-intro">
          The planner searches the lattice of assembly states (assembly-by-disassembly with directional blocking) using
          Dijkstra. Each step is charged for the issues it runs into: an unconstrained non-90&deg; angle, a concave joint
          closed too early, striking into a wobbly assembly. Compare the naive order with the planned one.
        </p>
        <AssemblyPlanner modelId={model} onModel={setModel} />
      </section>
    </>
  );
}

import { useEffect, useMemo, useRef, useState } from 'react';
import { MODEL_PRESETS } from './presets';
import { buildModel, Model } from './model';
import { plan, evalOrder, DEFAULT_WEIGHTS, Weights, Plan, Step, stepFor, isUnstable, IssueTag } from './planner';
import { Viewer } from './Viewer3D';
import { useScaffolds } from './useScaffolds';
import type { Scaffold3D, ScaffoldJob } from './scaffold3d';

const STEP_MS = 3000;
type Mode = 'naive' | 'planned';

export default function AssemblyPlanner({ modelId, onModel }: { modelId: string; onModel: (id: string) => void }) {
  const def = MODEL_PRESETS.find((m) => m.id === modelId) ?? MODEL_PRESETS[0];
  const model = useMemo(() => buildModel(def), [def]);
  const [W, setW] = useState<Weights>(DEFAULT_WEIGHTS);
  const lattice = useMemo(() => plan(model, W), [model, W]);
  const naive = useMemo(() => evalOrder(model, def.naive, W), [model, def, W]);
  const [mode, setMode] = useState<Mode>('planned');
  const [withScaffold, setWithScaffold] = useState(true);
  const seq: Plan = mode === 'planned' ? lattice.plan : naive;
  const n = seq.steps.length;
  const [showLong, setShowLong] = useState(false);
  const scafAll = useScaffolds(model, seq.steps, withScaffold);
  // long-joint trapezoids (issue 4) are hidden unless switched on in Details
  const scaf = {
    ...scafAll,
    byStep: scafAll.byStep.map((r) => (r && r.needed && r.longJoint && !showLong ? { ...r, needed: false, hidden: true } : r)),
  };

  // pos: number of completed steps, fractional while one is being inserted
  const [pos, setPos] = useState(0);
  const [playing, setPlaying] = useState(false);
  useEffect(() => { setPos(0); setPlaying(true); }, [model, mode]);
  useEffect(() => {
    if (!playing) return;
    let raf = 0, last = performance.now();
    const tick = (t: number) => {
      const dt = t - last;
      last = t;
      setPos((p) => {
        const np = Math.min(n, p + dt / STEP_MS);
        if (np >= n) setPlaying(false);
        return np;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, n]);

  const done = Math.floor(pos + 1e-9);
  const frac = pos - done;
  const focus = frac > 1e-6 ? done : Math.max(0, done - 1);

  // ---- three.js ----
  const host = useRef<HTMLDivElement>(null);
  const viewer = useRef<Viewer | null>(null);
  const [noGL, setNoGL] = useState(false);
  useEffect(() => {
    try {
      viewer.current = new Viewer(host.current!);
      viewer.current.setModel(model);
    } catch {
      setNoGL(true); // the planner and lattice still work without WebGL
    }
    return () => { viewer.current?.dispose(); viewer.current = null; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { viewer.current?.setModel(model); }, [model]);
  useEffect(() => {
    const placed = new Set(seq.steps.slice(0, done).map((s) => s.plate));
    const cur = done < n ? seq.steps[done] : null;
    // insertion takes the first 75% of a step, the rest is a pause
    const sc = withScaffold && cur && frac > 0 ? scaf.byStep[done] : null;
    viewer.current?.setFrame({
      placed,
      current: cur && frac > 0 ? cur.plate : null,
      step: cur,
      t: Math.min(1, frac / 0.75),
      scaffold: sc && sc.needed ? { key: scaf.keys[done]!, polys: sc.polys, tabs: sc.tabs } : null,
      strike: withScaffold && cur && frac > 0 && scaf.jobs[done] ? { plate: scaf.jobs[done]!.plate, dir: scaf.jobs[done]!.dir, onA: scaf.jobs[done]!.onA } : null,
      // after the plate is home the scaffolding breaks off
      breakT: frac > 0.75 ? (frac - 0.75) / 0.25 : 0,
      // planned order: its remaining issues are solved by fixes, shown in green
      // only while that step happens; once assembled everything is drawn in the default colours
      greenJoints: mode === 'planned' && cur && frac > 0 ? fixedJoints(model, [cur]) : new Set(),
      look: !cur ? 'normal' : mode === 'planned' ? (cur.rotary ? 'fix' : 'normal') : cur.issues.some((x) => x.cost > 0) ? 'issue' : 'normal',
    });
  }, [seq, done, frac, n, model, withScaffold, scaf, mode]);

  const stuck = !seq.feasible && mode === 'naive';
  const nextStuck = stuck && done >= n ? def.naive[n] : undefined;

  const cur = pos > 0 ? seq.steps[focus] : null;
  const curIssues = cur ? cur.issues.filter((x) => x.cost > 0) : [];

  return (
    <div className="demo1">
      <div className="card stage-wrap">
        <div className="stage-top">
          <div className="pick">
            <label htmlFor="assembly-model">Model:</label>
            <select id="assembly-model" value={def.id} onChange={(e) => onModel(e.target.value)}>
              {MODEL_PRESETS.map((m) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
          </div>
        </div>
        <div className="viewer" ref={host}>
          <div className="viz-top">
            <div className="player" style={{ flex: 1 }}>
              <label className="check">
                <input type="checkbox" checked={mode === 'planned'} onChange={(e) => setMode(e.target.checked ? 'planned' : 'naive')} />
                Constrain-before-insertion
              </label>
              <label className="check">
                <input type="checkbox" checked={withScaffold} onChange={(e) => setWithScaffold(e.target.checked)} />
                With scaffolding
              </label>
              <button className="btn sm" onClick={() => { setPos(0); setPlaying(true); }} title="Restart">&#8634;</button>
              <button className="btn sm" onClick={() => { setPlaying(false); setPos((p) => Math.max(0, Math.ceil(p - 1e-6) - 1)); }} title="Previous step">&#9664;</button>
              <button className="btn sm go" onClick={() => { if (pos >= n) setPos(0); setPlaying(!playing); }}>
                {playing ? '\u275a\u275a Pause' : '\u25b6 Play'}
              </button>
              <button className="btn sm" onClick={() => { setPlaying(false); setPos((p) => Math.min(n, Math.floor(p + 1e-6) + 1)); }} title="Next step">&#9654;</button>
              <input type="range" min={0} max={n} step={0.01} value={pos} onChange={(e) => { setPlaying(false); setPos(+e.target.value); }} />
              {withScaffold && scaf.pending > 0 && <span className="hint">FEA&hellip;</span>}
            </div>
          </div>
          {noGL && <div className="hint" style={{ padding: 20 }}>3D view unavailable: this browser could not create a WebGL context.</div>}
        </div>
        <OrderVerdict mode={mode} naive={naive} planned={lattice.plan} scaffolded={withScaffold ? scaf.byStep.filter((r) => r?.needed).length : 0} />
        <div className="controls">
        <ol className="order">
          {seq.steps.map((s, i) => {
            // naive: a problem (red). planned: the issue is solved by a fix (green)
            const bad = mode === 'naive' && s.issues.some((x) => x.cost > 0);
            const fixed = mode === 'planned' && s.issues.some((x) => x.cost > 0);
            const scaffolded = withScaffold && !!scaf.byStep[i]?.needed;
            const state = i === focus && pos > 0 ? 'on' : i < done ? 'done' : '';
            return (
              <li key={i} className={`${state} ${bad ? 'bad' : ''} ${fixed ? 'fixed' : ''} ${scaffolded ? 'scaf' : ''}`} onClick={() => { setPlaying(false); setPos(i + 1); }}>
                {i + 1}. {model.plates[s.plate].name}
                {s.rotary && ' \u21bb'}
                {bad && <span className="cost"> +{s.cost}</span>}
              </li>
            );
          })}
          {nextStuck !== undefined && <li className="bad on">{n + 1}. {model.plates[nextStuck].name}: stuck</li>}
        </ol>
        <div className="caption">
          {nextStuck !== undefined ? (
            <span className="v bad">
              {model.nonConvex[nextStuck]
                ? `${model.plates[nextStuck].name} is a concave-polygon plate: its notch can no longer get around the concave corner, which is already closed.`
                : `${model.plates[nextStuck].name} is interlocked: there is no way to insert it now.`}
            </span>
          ) : cur ? (
            curIssues.length ? (
              curIssues.map((x, k) => (
                <div key={k}><span className={`tag c${x.issue}`}>{x.issue}</span> {x.text}. <span className="fix">Fix: {x.fix}</span></div>
              ))
            ) : (
              <span className="v ok">Step {focus + 1}: {model.plates[cur.plate].name}, no assembly-order issues.</span>
            )
          ) : (
            <span className="hint">Press Play, or click a step.</span>
          )}
          {withScaffold && cur && <ScaffoldNote r={scaf.byStep[focus]} job={scaf.jobs[focus]} model={model} />}
        </div>
        </div>
        <details className="details">
          <summary>Details: per-step issues, assembly lattice and penalty weights</summary>
          <div className="readout">
            <label className="check">
              <input type="checkbox" checked={showLong} onChange={(e) => setShowLong(e.target.checked)} />
              Show long-joint scaffolding (issue 4)
            </label>
            <div>
              <h4>Steps ({mode === 'planned' ? `planned, ${lattice.expanded} states searched` : 'naive'})</h4>
              <ol className="seq">
                {seq.steps.map((s, i) => (
                  <StepItem
                    key={i}
                    i={i}
                    s={s}
                    model={model}
                    on={i === focus && pos > 0}
                    future={i >= Math.ceil(pos - 1e-6) && !(i === focus && pos > 0)}
                    onClick={() => { setPlaying(false); setPos(i + 1); }}
                  />
                ))}
              </ol>
            </div>
            <div>
              <h4>Assembly lattice: every state is a set of assembled plates</h4>
              <LatticeView model={model} W={W} planned={lattice.plan} naive={naive} mode={mode} focusMask={pos > 0 ? (seq.steps[focus]?.to ?? 0) : 0} />
            </div>
            <div>
              <h4>Penalty function</h4>
              <div className="param">
                {(
                  [
                    ['angle', 'Unconstrained non-90\u00b0 joint (6)'],
                    ['concave', 'Concave joint closed early (9)'],
                    ['unstable', 'Strike into wobbly A at several joints (10)'],
                    ['unstableVise', 'Strike into wobbly A, vise possible (10)'],
                    ['rotary', 'Rotary insertion (sweep carved)'],
                  ] as [keyof Weights, string][]
                ).map(([k, label]) => (
                  <Slider key={k} label={label} value={W[k]} onChange={(v) => setW({ ...W, [k]: v })} />
                ))}
              </div>
              <p className="hint">
                Every step costs 1 plus its penalties. Interlocked steps are impossible (&infin;). Each step&rsquo;s strike
                direction comes from directional blocking: box-joint fingers slide perpendicular to their edge, T-joint tabs
                along the slot.
              </p>
              <button className="btn sm" onClick={() => setW(DEFAULT_WEIGHTS)}>Reset weights</button>
            </div>
          </div>
        </details>
      </div>
    </div>
  );
}

const TAG_ISSUE: Record<IssueTag, number> = { angle: 6, align: 7, concave: 9, unstable: 10, rotary: 9 };

function countIssues(p: Plan) {
  return p.steps.reduce((s, st) => s + st.issues.filter((i) => i.cost > 0).length, 0);
}

/** joints changed by the fixes of these steps: swept for rotary insertion, tapered, T-joint/deepened */
function fixedJoints(model: Model, steps: Step[]): Set<number> {
  const out = new Set<number>();
  for (const s of steps)
    for (const x of s.issues) {
      if (x.cost <= 0) continue;
      const js = x.tag === 'rotary' ? s.joints
        : x.tag === 'angle' ? s.joints.filter((k) => !model.joints[k].right)
        : x.tag === 'concave' ? s.joints.filter((k) => model.joints[k].concave)
        : [];
      js.forEach((k) => out.add(k));
    }
  return out;
}

function ScaffoldNote({ r, job, model }: { r: Scaffold3D | null | undefined; job: ScaffoldJob | null; model: Model }) {
  if (r === null || !job) return null; // rotated in: no trapezoid
  const where = job.onA
    ? `P could only be struck on its face, so the blow goes onto assembly A instead, via the edge of ${model.plates[job.plate].name}.`
    : '';
  if (r === undefined) return <div className="hint">{where} Running the FEA for this plate&hellip;</div>;
  if (r.hidden) return <div className="hint">{where} FEA: long joint (issue 4), so this plate would need several trapezoids; hidden here (Details &rarr; Show long-joint scaffolding).</div>;
  if (!r.needed) return <div className="hint">{where} FEA: an existing edge works as the target, so no scaffolding is needed.</div>;
  return (
    <div>
      {where && <div className="hint">{where}</div>}
      <i className="swatch" style={{ background: 'var(--scaffold)' }} /> Trapezoidal scaffolding added{job.onA ? ` on assembly A (${model.plates[job.plate].name})` : ''}
      {r.fails.length > 0 && <>: {r.fails.map((f, k) => <span key={k}> <span className={`tag c${f.issue}`}>{f.issue}</span> {f.text}.</span>)}</>}
    </div>
  );
}

function OrderVerdict({ mode, naive, planned, scaffolded }: { mode: Mode; naive: Plan; planned: Plan; scaffolded: number }) {
  const p = mode === 'naive' ? naive : planned;
  const k = countIssues(p);
  const cost = p.feasible ? p.cost.toFixed(0) : '\u221e';
  const ok = mode === 'planned' && p.feasible && p.cost < naive.cost;
  const naiveCost = naive.feasible ? naive.cost.toFixed(0) : '\u221e';
  const title = mode === 'naive'
    ? !p.feasible
      ? 'This order gets stuck: a plate can no longer be inserted'
      : k === 0
        ? `This order assembles without issues (cost ${cost})`
        : `This order runs into ${k} issue${k === 1 ? '' : 's'} (cost ${cost})`
    : ok
      ? `Constrain-before-insertion: cost ${cost} instead of ${naiveCost}`
      : `Planned order (cost ${cost})`;
  const orderNote = mode === 'naive'
    ? 'Check \u201cConstrain-before-insertion\u201d to see the fix.'
    : k === 0
      ? 'No step needs an assembly-order fix.'
      : `${k} step${k === 1 ? ' still needs' : 's still need'} a fix that reordering can\u2019t avoid (green below).`;
  const scafNote = scaffolded > 0 ? ` ${scaffolded} step${scaffolded === 1 ? ' gets' : 's get'} trapezoidal scaffolding (green below).` : '';
  const sub = orderNote + scafNote;
  return (
    <div className={`verdict ${mode === 'naive' && (k > 0 || !p.feasible) ? 'bad' : 'ok'}`}>
      <span>{mode === 'naive' && (k > 0 || !p.feasible) ? '\u2717' : '\u2713'}</span>
      <div>
        {title}
        <div className="sub">{sub}</div>
      </div>
    </div>
  );
}

function StepItem({ i, s, model, on, future, onClick }: { i: number; s: Step; model: Model; on: boolean; future: boolean; onClick: () => void }) {
  const costly = s.issues.filter((x) => x.cost > 0);
  const info = s.issues.filter((x) => x.cost === 0);
  return (
    <li className={`${on ? 'on' : ''} ${future ? 'future' : ''}`} onClick={onClick}>
      <div className="row">
        <span className="pl">
          {i + 1}. {model.plates[s.plate].name}
          {s.neighbors.length > 0 && <span className="hint"> &rarr; {s.neighbors.map((k) => model.plates[k].name).join(', ')}</span>}
        </span>
        <span className={`cost ${s.cost > 1 ? 'hi' : ''}`}>{i === 0 ? 'start' : `+${s.cost}`}</span>
      </div>
      {(costly.length > 0 || (on && info.length > 0)) && (
        <div className="iss">
          {costly.map((x, k) => (
            <div key={k}>
              <span className={`tag c${TAG_ISSUE[x.tag]}`}>{x.issue}</span>
              <span>
                {x.text}
                {on && <><br /><span className="fix">Fix: {x.fix}</span></>}
              </span>
            </div>
          ))}
          {on && info.map((x, k) => (
            <div key={'i' + k}>
              <span className={`tag c${TAG_ISSUE[x.tag]}`}>{x.issue}</span>
              <span>{x.text}. <span className="fix">{x.fix}</span></span>
            </div>
          ))}
        </div>
      )}
    </li>
  );
}

function Slider({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <>
      <span>{label}</span>
      <span className="v">{value}</span>
      <input type="range" min={0} max={30} value={value} onChange={(e) => onChange(+e.target.value)} />
    </>
  );
}

// ---------------------------------------------------------------------------

function LatticeView({
  model, W, planned, naive, mode, focusMask,
}: { model: Model; W: Weights; planned: Plan; naive: Plan; mode: Mode; focusMask: number }) {
  const n = model.plates.length;
  const graph = useMemo(() => {
    // small models: every reachable state. Larger ones (the chair has ~4000
    // states) only show the two sequences and their one-step alternatives.
    const edges: { from: number; to: number; cost: number; tag: IssueTag | null }[] = [];
    const seen = new Set<number>([0]);
    const expand = (m: number) => {
      const out: number[] = [];
      for (let p = 0; p < n; p++) {
        if (m & (1 << p)) continue;
        const s = stepFor(model, m, p, W);
        if (!s) continue;
        if (m !== 0) {
          const worst = s.issues.filter((x) => x.cost > 0).sort((a, b) => b.cost - a.cost)[0];
          edges.push({ from: m, to: s.to, cost: s.cost, tag: worst?.tag ?? null });
        }
        seen.add(s.to);
        out.push(s.to);
      }
      return out;
    };
    if (n <= 7) {
      let frontier = [0];
      for (let k = 0; k < n; k++) {
        const next = new Set<number>();
        for (const m of frontier) expand(m).forEach((x) => next.add(x));
        frontier = [...next];
      }
    } else {
      const onPaths = new Set<number>();
      for (const p of [planned, naive]) p.steps.forEach((st) => { onPaths.add(st.from); onPaths.add(st.to); });
      onPaths.forEach((m) => { if (m) expand(m); });
      // keep only edges that start on a path, and the path states themselves
      onPaths.forEach((m) => seen.add(m));
    }
    // layers by number of plates, ordered by the barycentre of their parents
    const layers: number[][] = Array.from({ length: n + 1 }, () => []);
    seen.forEach((m) => { if (m) layers[popcount(m)].push(m); });
    const order = new Map<number, number>();
    layers[1].sort((a, b) => a - b).forEach((m, i) => order.set(m, i / Math.max(1, layers[1].length - 1)));
    for (let k = 2; k <= n; k++) {
      const bary = (m: number) => {
        const ps = edges.filter((e) => e.to === m).map((e) => order.get(e.from) ?? 0.5);
        return ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : 0.5;
      };
      layers[k].sort((a, b) => bary(a) - bary(b) || a - b).forEach((m, i) => order.set(m, layers[k].length === 1 ? 0.5 : i / (layers[k].length - 1)));
    }
    return { edges, layers, order };
  }, [model, W, n, planned, naive]);

  const Wd = 760, H = 300, padX = 40, padY = 22;
  const pos = (m: number): [number, number] => {
    const k = popcount(m);
    const layer = graph.layers[k];
    const x = padX + ((k - 1) / Math.max(1, n - 1)) * (Wd - 2 * padX);
    const spread = Math.min(1, layer.length / 12);
    const y = H / 2 + ((graph.order.get(m) ?? 0.5) - 0.5) * (H - 2 * padY) * Math.max(0.25, spread);
    return [x, y];
  };
  const pathEdges = (p: Plan) => p.steps.slice(1).map((s) => [s.from, s.to] as [number, number]);
  const tagColor = (t: IssueTag | null) =>
    t === 'angle' ? 'var(--oblique)' : t === 'concave' ? 'var(--concave)' : t === 'unstable' ? 'var(--bad)' : t === 'rotary' ? 'var(--warn)' : 'var(--line)';
  const names = (m: number) => model.plates.filter((_, i) => m & (1 << i)).map((p) => p.name).join(', ');
  const active = mode === 'planned' ? planned : naive;
  const other = mode === 'planned' ? naive : planned;

  return (
    <svg className="lattice" viewBox={`0 0 ${Wd} ${H + 26}`}>
      {graph.edges.map((e, i) => {
        const [x1, y1] = pos(e.from), [x2, y2] = pos(e.to);
        return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke={tagColor(e.tag)} strokeWidth={e.tag ? 1.4 : 1} opacity={e.tag ? 0.6 : 0.9} />;
      })}
      {[other, active].map((p, pi) => (
        <g key={pi}>
          {pathEdges(p).map(([a, b], i) => {
            const [x1, y1] = pos(a), [x2, y2] = pos(b);
            const isActive = pi === 1;
            const col = p === planned ? 'var(--ok)' : 'var(--bad)';
            return (
              <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke={col} strokeWidth={isActive ? 3.2 : 1.8}
                strokeDasharray={p === naive ? '5 3' : undefined} opacity={isActive ? 1 : 0.45} strokeLinecap="round" />
            );
          })}
        </g>
      ))}
      {graph.layers.flatMap((layer) =>
        layer.map((m) => {
          const [x, y] = pos(m);
          const unstable = isUnstable(model, m);
          const isFocus = m === focusMask;
          const onPath = active.steps.some((s) => s.to === m);
          return (
            <g key={m}>
              <circle cx={x} cy={y} r={isFocus ? 7.5 : onPath ? 5.5 : 4}
                fill={unstable ? 'var(--bad)' : onPath ? 'var(--ink)' : 'var(--panel)'}
                stroke={isFocus ? 'var(--accent)' : unstable ? 'var(--bad)' : 'var(--ink-3)'} strokeWidth={isFocus ? 3 : 1} />
              <title>{`${names(m)}${unstable ? ' (not rigid)' : ''}`}</title>
            </g>
          );
        }),
      )}
      {Array.from({ length: n }, (_, k) => (
        <text key={k} x={padX + (k / Math.max(1, n - 1)) * (Wd - 2 * padX)} y={H + 18} textAnchor="middle" fontSize={11} fill="var(--ink-3)">
          {k + 1} plate{k ? 's' : ''}
        </text>
      ))}
      <g fontSize={11} fill="var(--ink-2)" transform={`translate(${Wd - 270},0)`}>
        <line x1={8} x2={30} y1={10} y2={10} stroke="var(--ok)" strokeWidth={3} /><text x={36} y={14}>planned</text>
        <line x1={100} x2={122} y1={10} y2={10} stroke="var(--bad)" strokeWidth={2} strokeDasharray="5 3" /><text x={128} y={14}>naive</text>
        <circle cx={196} cy={10} r={4} fill="var(--bad)" /><text x={205} y={14}>not rigid</text>
      </g>
    </svg>
  );
}

const popcount = (m: number) => {
  let c = 0;
  while (m) { m &= m - 1; c++; }
  return c;
};
